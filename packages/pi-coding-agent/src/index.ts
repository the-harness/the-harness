import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentLoop, SupplementaryField } from "@harness/agent-loop";
import { AgentPreset, AgentPresetRegistry } from "@harness/agent-preset";
import { AgentsMdService } from "@harness/agents-md";
import { Context } from "@harness/context";
import { useContextSize } from "@harness/context-size";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import {
  DeveloperMessage,
  extractText,
  LlmService,
  MessageMeta,
  snapshotSystemPrompt,
  SystemMessage,
  TextBlock,
  type Message,
} from "@harness/llm";
import { useMcp } from "@harness/mcp";
import { ModelSelectionService } from "@harness/model-selection";
import { PiCompactionService, useCompaction } from "@harness/pi-compaction";
import { usePiTools } from "@harness/pi-tools";
import { SkillsService } from "@harness/skills";
import { ToolCallService, useToolCall, useToolCallCompaction } from "@harness/tool-call";
import { variant } from "@harness/variants";
import { piIcon } from "./icon.ts";
import {
  buildPiSystemPromptSections,
  PI_DEFAULT_PREAMBLE,
  PI_SYSTEM_PROMPT_SECTIONS,
} from "./systemPrompt.ts";

export interface PiCodingAgentOptions {
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
}

type ReadPromptSections = () => Readonly<Record<string, string>>;
type PreparePiSystemPrompt = (messages: readonly Message[]) => readonly SystemMessage[];
interface PiPresetSetupOptions {
  readonly automaticPromptUpdates?: boolean;
  readonly registerTools?: boolean;
}
const presetSections = new Set<string>(PI_SYSTEM_PROMPT_SECTIONS);
const CustomPromptSection = MessageMeta.defineField<boolean, typeof MessageMeta>(
  "pi:cli:extension-prompt-section",
);

@variant("core:pi-coding-agent:preset")
export class PiCodingAgentPreset extends AgentPreset {
  declare readonly systemPrompt?: string;
  declare readonly appendSystemPrompt?: string;

  override setup(
    readSections?: ReadPromptSections,
    options?: PiPresetSetupOptions,
  ): PreparePiSystemPrompt {
    return setupPiCodingAgent(readSections ?? defaultPromptSections(this), options);
  }
}

// pi compacts once the active window exceeds contextWindow - reserveTokens.
const COMPACTION_RESERVE_TOKENS = 16384;

function resolveCompactionBudget(): number | undefined {
  const selection = inject(ModelSelectionService).current;
  const model = inject(LlmService).models.find(
    (item) => item.provider === selection.provider && item.id === selection.model,
  );
  if (model === undefined) return undefined;
  return Math.max(model.contextWindow - COMPACTION_RESERVE_TOKENS, 0) || undefined;
}

export function usePiCodingAgentPreset(options: PiCodingAgentOptions = {}): void {
  inject(AgentPresetRegistry).usePreset(
    PiCodingAgentPreset.create({
      id: "pi-coding-agent",
      name: "Pi Coding Agent",
      description: "Coding assistant aligned with pi-coding-agent",
      icon: piIcon,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
    }),
  );
}

function setupPiCodingAgent(
  readSections: ReadPromptSections,
  options: PiPresetSetupOptions = {},
): PreparePiSystemPrompt {
  useContextSize();
  const context = inject(Context);
  const loop = inject(AgentLoop);
  const prepare = createPromptPlanner(readSections);
  const automaticPromptUpdates = options.automaticPromptUpdates !== false;
  if (automaticPromptUpdates) {
    context.hooks.batch.use((messages, next) =>
      next(context.batchCount === 0 ? [...prepare(messages), ...messages] : messages),
    );
  }
  loop.hooks.transformContext.use(async (input, next) => {
    const payload = await next(input);
    const messages = payload.messages.filter((message) => !isLegacyPiPromptMessage(message));
    const updates = automaticPromptUpdates ? prepare(messages) : [];
    if (updates.length > 0) context.pending.push(...updates);
    return { ...payload, messages: [...messages, ...updates] };
  });
  inject(PiCompactionService).hooks.compact.use((input, next) =>
    next({
      ...input,
      messages: input.messages.filter((message) => !isLegacyPiPromptMessage(message)),
    }),
  );

  useCompaction({ maxTokens: resolveCompactionBudget() });
  useToolCall();
  useToolCallCompaction();
  if (options.registerTools !== false) {
    useMcp();
    usePiTools();
  }
  return prepare;
}

function defaultPromptSections(options: PiCodingAgentOptions): ReadPromptSections {
  const cwd = inject(CwdService);
  const tools = inject(ToolCallService);
  const agentsMd = inject(AgentsMdService);
  const skills = inject(SkillsService);
  const home = homedir();

  agentsMd.useSearchDir(join(home, ".pi", "agent"));
  skills.useRoot(join(home, ".pi", "agent", "skills"));
  skills.useRoot(join(resolve(cwd.cwd), ".pi", "skills"));

  return () =>
    options.systemPrompt !== undefined
      ? options.systemPrompt
        ? { preamble: options.systemPrompt }
        : {}
      : buildPiSystemPromptSections({
          cwd: cwd.cwd,
          tools: tools.tools.map((tool) => tool.name),
          appendSystemPrompt: options.appendSystemPrompt,
          contextFiles: agentsMd.discover(),
          skills: skills.discover(),
        });
}

function createPromptPlanner(readSections: ReadPromptSections): PreparePiSystemPrompt {
  return (messages) => {
    const systems = snapshotSystemPrompt(
      messages.filter(
        (message): message is SystemMessage =>
          message instanceof SystemMessage && !isLegacyPiPromptMessage(message),
      ),
    );
    const previous = new Map(
      systems.map((message) => [message.sectionId, extractText(message.content)]),
    );
    const current = readSections();
    const updates: SystemMessage[] = [];
    for (const [id, text] of Object.entries(current)) {
      if (previous.get(id) !== text) updates.push(createPiPromptSection(id, text));
    }
    for (const message of systems) {
      const id = message.sectionId;
      if (
        id !== undefined &&
        !Object.hasOwn(current, id) &&
        (presetSections.has(id) || message.meta.get(CustomPromptSection))
      ) {
        updates.push(createPiPromptSection(id));
      }
    }
    return updates;
  };
}

export function createPiPromptSection(sectionId: string, text?: string): SystemMessage {
  const meta = new MessageMeta().set(SupplementaryField, true);
  if (!presetSections.has(sectionId)) meta.set(CustomPromptSection, true);
  return SystemMessage.create({
    sectionId,
    content: text === undefined ? [] : [TextBlock.create({ text })],
    meta,
  });
}

function isLegacyPiPromptMessage(message: Message): boolean {
  if (message instanceof SystemMessage && message.sectionId === undefined) {
    return extractText(message.content).startsWith(`${PI_DEFAULT_PREAMBLE}\n\n<tools>\n`);
  }
  return (
    message instanceof DeveloperMessage &&
    message.meta.get(SupplementaryField) === true &&
    /^(Updated|Removed) system prompt section "/.test(extractText(message.content))
  );
}
