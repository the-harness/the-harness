import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentLoop, SupplementaryField } from "@harness/agent-loop";
import { AgentPreset, AgentPresetRegistry } from "@harness/agent-preset";
import { AgentsMdService, type AgentsMdFile } from "@harness/agents-md";
import { CodexApplyPatchService } from "@harness/codex-apply-patch";
import {
  CodexCompactionService,
  CodexCompactionSummaryMessage,
  useCodexCompaction,
} from "@harness/codex-compaction";
import { useCodexTools } from "@harness/codex-tools";
import { Context } from "@harness/context";
import { useContextSize } from "@harness/context-size";
import { CwdService } from "@harness/cwd";
import { createDescriptor, inject, useServices } from "@harness/di";
import { JobService } from "@harness/jobs";
import {
  extractText,
  LlmService,
  MessageMeta,
  snapshotSystemPrompt,
  SystemMessage,
  TextBlock,
  UserMessage,
  type Message,
} from "@harness/llm";
import { useMcp } from "@harness/mcp";
import { ModelSelectionService } from "@harness/model-selection";
import { PiCompactionService } from "@harness/pi-compaction";
import { useToolCall } from "@harness/tool-call";
import { variant } from "@harness/variants";
import { codexIcon } from "./icon.ts";
import {
  buildCodexSystemPromptSections,
  renderAgentsMd,
  renderCodexInstructions,
  renderEnvironmentContext,
  type CodexAgentsMdFile,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexSystemPromptSection,
} from "./systemPrompt.ts";

export interface CodexCodingAgentOptions {
  readonly instructions?: string;
  readonly developerInstructions?: string;
  readonly compactPrompt?: string;
  readonly updatePlan?: boolean;
  readonly viewImage?: boolean;
  readonly webSearch?: boolean;
  readonly includePermissionsInstructions?: boolean;
  readonly includeCollaborationMode?: boolean;
  readonly includeEnvironmentContext?: boolean;
  readonly includeEnvironmentContextTime?: boolean;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly sandboxMode?: CodexSandboxMode;
  readonly networkAccess?: boolean;
  readonly writableRoots?: readonly string[];
  readonly projectDocMaxBytes?: number;
  readonly registerTools?: boolean;
  readonly automaticPromptUpdates?: boolean;
  readonly autoCompactTokenLimit?: number;
}

type CodexContextFragmentKind = "agents_md" | "environment_context";

interface CodexContextFragmentState {
  readonly kind: CodexContextFragmentKind;
  readonly state: string;
}

interface CodexContextFragmentPlan {
  readonly kind: CodexContextFragmentKind;
  readonly state: string;
  readonly first: string;
  readonly delta: string;
}

const DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;

const ContextFragmentField = MessageMeta.defineField<
  CodexContextFragmentState,
  typeof MessageMeta
>("core:codex-coding-agent:context-fragment");

@variant("core:codex-coding-agent:preset")
export class CodexCodingAgentPreset extends AgentPreset {
  declare readonly options?: CodexCodingAgentOptions;

  override setup(): void {
    setupCodexCodingAgent(this.options ?? {});
  }
}

export function useCodexCodingAgentPreset(options: CodexCodingAgentOptions = {}): void {
  inject(AgentPresetRegistry).usePreset(
    CodexCodingAgentPreset.create({
      id: "codex",
      name: "Codex",
      description: "Codex-style coding assistant for editing files and running commands",
      icon: codexIcon,
      options,
    }),
  );
}

function resolveMaxActiveTokens(options: CodexCodingAgentOptions): number | undefined {
  const selection = inject(ModelSelectionService).current;
  const model = inject(LlmService).models.find(
    (item) => item.provider === selection.provider && item.id === selection.model,
  );
  const contextWindowLimit =
    model === undefined ? undefined : Math.floor((model.contextWindow * 9) / 10);
  const configured = options.autoCompactTokenLimit;
  if (configured === undefined) return contextWindowLimit;
  return contextWindowLimit === undefined ? configured : Math.min(configured, contextWindowLimit);
}

function setupCodexCodingAgent(options: CodexCodingAgentOptions): void {
  useContextSize();
  const context = inject(Context);
  const loop = inject(AgentLoop);
  const cwd = inject(CwdService);
  const agentsMd = inject(AgentsMdService);
  const codexHome = join(homedir(), ".codex");

  agentsMd.useSearchDir(codexHome);
  const automaticPromptUpdates = options.automaticPromptUpdates !== false;
  const readSections = (): readonly CodexSystemPromptSection[] =>
    buildCodexSystemPromptSections(options);
  const readFragments = (): readonly CodexContextFragmentPlan[] =>
    planContextFragments(options, cwd.cwd, agentsMd.discover(), codexHome);

  useServices([JobService, CodexApplyPatchService]);
  useServices([
    [
      PiCompactionService,
      createDescriptor(CodexCompactionService, {
        baseInstructions: () => renderCodexInstructions(options),
        compactPrompt: options.compactPrompt,
      }),
    ],
  ]);

  context.hooks.batch.use((messages, next) => {
    if (context.batchCount > 0) return next(messages);
    const sections = readSections().map((section) =>
      createCodexPromptSection(section.id, section.text),
    );
    const fragments = readFragments()
      .filter((plan) => plan.state.length > 0)
      .map((plan) => createCodexFragmentMessage(plan, plan.first));
    return next([...sections, ...fragments, ...messages]);
  });

  let seenSummary: Message | undefined;

  loop.hooks.transformContext.use(async (input, next) => {
    const payload = await next(input);
    const messages = [...payload.messages];
    // Codex compacts before the incoming turn, so a freshly installed summary belongs right
    // before the current user message rather than after it.
    const summary = messages.findLast(
      (message) => message instanceof CodexCompactionSummaryMessage,
    );
    if (summary !== undefined && summary !== seenSummary && messages.at(-1) === summary) {
      seenSummary = summary;
      const lastRealUser = messages.findLastIndex(
        (message) =>
          message instanceof UserMessage &&
          !(message instanceof CodexCompactionSummaryMessage) &&
          message.meta.get(SupplementaryField) !== true,
      );
      if (lastRealUser >= 0) {
        messages.splice(messages.length - 1, 1);
        messages.splice(lastRealUser, 0, summary);
      }
    }
    const appended: Message[] = [];
    if (automaticPromptUpdates) {
      const previous = new Map<string, string>();
      for (const message of snapshotSystemPrompt(
        messages.filter((message): message is SystemMessage => message instanceof SystemMessage),
      )) {
        if (message.sectionId !== undefined) {
          previous.set(message.sectionId, extractText(message.content));
        }
      }
      for (const section of readSections()) {
        if (previous.get(section.id) !== section.text) {
          appended.push(createCodexPromptSection(section.id, section.text));
        }
      }
    }
    const visible = new Map<CodexContextFragmentKind, string>();
    for (const message of messages) {
      const fragment = message.meta.get(ContextFragmentField);
      if (fragment !== undefined) visible.set(fragment.kind, fragment.state);
    }
    const reinjected: Message[] = [];
    for (const plan of readFragments()) {
      const previous = visible.get(plan.kind);
      if (previous === undefined) {
        if (plan.state.length > 0) {
          reinjected.push(createCodexFragmentMessage(plan, plan.first));
        }
      } else if (previous !== plan.state) {
        appended.push(createCodexFragmentMessage(plan, plan.delta));
      }
    }
    if (reinjected.length > 0 || appended.length > 0) {
      context.pending.push(...reinjected, ...appended);
    }
    if (reinjected.length > 0) {
      let index = 0;
      while (index < messages.length && messages[index] instanceof SystemMessage) index += 1;
      messages.splice(index, 0, ...reinjected);
    }
    messages.push(...appended);
    return { ...payload, messages };
  });

  useCodexCompaction({ maxTokens: resolveMaxActiveTokens(options) });
  useToolCall();
  if (options.registerTools !== false) {
    useCodexTools({
      updatePlan: options.updatePlan,
      viewImage: options.viewImage,
      webSearch: options.webSearch,
    });
    useMcp();
  }
}

function createCodexPromptSection(sectionId: string, text: string): SystemMessage {
  return SystemMessage.create({
    sectionId,
    content: [TextBlock.create({ text })],
    meta: new MessageMeta().set(SupplementaryField, true),
  });
}

function createCodexFragmentMessage(
  plan: CodexContextFragmentPlan,
  text: string,
): UserMessage {
  return UserMessage.create({
    content: [TextBlock.create({ text })],
    meta: new MessageMeta()
      .set(SupplementaryField, true)
      .set(ContextFragmentField, { kind: plan.kind, state: plan.state }),
  });
}

function planContextFragments(
  options: CodexCodingAgentOptions,
  cwd: string,
  discovered: readonly AgentsMdFile[],
  codexHome: string,
): readonly CodexContextFragmentPlan[] {
  const plans: CodexContextFragmentPlan[] = [];
  const files = collectAgentsMdFiles(
    discovered,
    codexHome,
    options.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
  );
  const agentsMd = files.length > 0 ? renderAgentsMd(files, cwd) : "";
  plans.push({
    kind: "agents_md",
    state: agentsMd,
    first: agentsMd,
    delta:
      files.length > 0
        ? renderAgentsMd(files, cwd, "replacement")
        : renderAgentsMd(files, cwd, "removal"),
  });
  if (options.includeEnvironmentContext !== false) {
    const environmentContext = renderEnvironmentContext(cwd, {
      includeTime: options.includeEnvironmentContextTime !== false,
    });
    plans.push({
      kind: "environment_context",
      state: environmentContext,
      first: environmentContext,
      delta: environmentContext,
    });
  }
  return plans;
}

function collectAgentsMdFiles(
  discovered: readonly AgentsMdFile[],
  codexHome: string,
  projectDocMaxBytes: number,
): readonly CodexAgentsMdFile[] {
  if (projectDocMaxBytes === 0) return [];
  const files: CodexAgentsMdFile[] = [];
  const projectDocs: AgentsMdFile[] = [];
  for (const file of discovered) {
    if (dirname(resolve(file.path)) !== codexHome) {
      projectDocs.push(file);
      continue;
    }
    const content = file.content.trim();
    if (content.length > 0) files.push({ path: file.path, content, global: true });
  }
  let remaining = projectDocMaxBytes;
  for (const file of projectDocs) {
    if (remaining === 0) break;
    const bytes = Buffer.from(file.content, "utf8");
    const content =
      bytes.length > remaining ? bytes.subarray(0, remaining).toString("utf8") : file.content;
    if (content.trim().length === 0) continue;
    files.push({ path: file.path, content });
    remaining -= Buffer.byteLength(content, "utf8");
  }
  return files;
}
