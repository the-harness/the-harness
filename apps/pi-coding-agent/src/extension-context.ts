import {
  createInitialSystemMessage,
  getCurrentSystemMessage,
  getCurrentTools,
  getToolStateChanges,
} from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  convertToLlm,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  SessionManager,
  type AgentBeforeSettleEvent,
  type BoundaryContextPreview,
  type CompactionEntryDraft,
  type ExtensionRunner,
  type SessionEntry,
  type SessionBoundaryDraft,
  type TurnEndEvent,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { SupplementaryField, type LlmInputPayload } from "@harness/agent-loop";
import {
  FunctionToolDeclaration,
  extractText,
  SystemMessage,
  TextBlock,
  MessageMeta,
  ToolResultMessage,
  UserMessage,
  type Message,
} from "@harness/llm";
import { fromPiTool, toPiTool } from "./tool-declarations.ts";
import { AddToolMessage, RemoveToolMessage } from "@harness/tool-call";
import {
  customMessage,
  fromPiAssistant,
  fromPiContent,
  toPiMessages,
  type PiMessage,
} from "./extension-content.ts";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { estimateProjectedContextTokens } = (await import(
  new URL("core/compaction/compaction.js", sdk).href
)) as {
  estimateProjectedContextTokens(
    projection: SessionProjection,
    branch: SessionEntry[],
  ): { tokens: number };
};

export function contextUsage(transcript: SessionManager, contextWindow: number) {
  if (contextWindow <= 0) return undefined;
  const branch = transcript.getBranch();
  const projection = transcript.buildSessionProjection();
  const compaction = getLatestCompactionEntry(branch);
  if (compaction) {
    const boundary = branch.findIndex((entry) => entry.id === compaction.id);
    const newer = new Set(branch.slice(boundary + 1).map((entry) => entry.id));
    const hasUsage = projection.entries.some(
      ({ sourceEntry, messages }) =>
        newer.has(sourceEntry.id) &&
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.stopReason !== "error" &&
            message.stopReason !== "aborted" &&
            calculateContextTokens(message.usage) > 0,
        ),
    );
    if (!hasUsage) return { tokens: null, contextWindow, percent: null };
  }
  const { tokens } = estimateProjectedContextTokens(projection, branch);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

function messageKey(message: PiMessage): string {
  if (message.role === "system") {
    return JSON.stringify([message.role, message.timestamp, message.content, message.sections]);
  }
  return JSON.stringify(message);
}

type PiSystemMessage = Extract<PiMessage, { role: "system" }>;

interface ContextProjection {
  message: PiMessage;
  readonly originals: readonly Message[];
}

interface ContextSources {
  readonly getEntry: (messageId: string) => SessionEntry | undefined;
  readonly hiddenDeclarations: ReadonlySet<string>;
}

function sourceSystemMessage(entry: SessionEntry | undefined): PiSystemMessage | undefined {
  if (entry?.type === "message" && entry.message.role === "system") return entry.message;
  if (entry?.type === "compaction") return entry.systemMessage;
}

function projectSystemGroup(
  originals: readonly SystemMessage[],
  source: PiSystemMessage,
  hidden: ReadonlySet<string>,
): PiSystemMessage {
  const sections = new Map<string, string | null>();
  const base: string[] = [];
  for (const native of originals) {
    const text = extractText(native.content);
    if (native.sectionId !== undefined && Object.hasOwn(source.sections ?? {}, native.sectionId)) {
      sections.set(native.sectionId, native.content.length ? text : null);
    } else if (text) {
      base.push(text);
    }
  }
  const text = base.join("\n\n");
  const originalText =
    typeof source.content === "string"
      ? source.content
      : (source.content?.map(({ text }) => text).join("") ?? "");
  const toolsAdded = source.toolsAdded?.filter(({ name }) => !hidden.has(name));
  const toolsRemoved = source.toolsRemoved?.filter(({ name }) => !hidden.has(name));
  return {
    role: "system",
    content: text === originalText ? (source.content ?? "") : text,
    timestamp: source.timestamp,
    ...(sections.size ? { sections: Object.fromEntries(sections) } : {}),
    ...(toolsAdded ? { toolsAdded } : {}),
    ...(toolsRemoved ? { toolsRemoved } : {}),
  };
}

function projectContextMessages(
  messages: readonly Message[],
  { getEntry, hiddenDeclarations }: ContextSources,
): ContextProjection[] {
  const projected: ContextProjection[] = [];
  let group: { id: string; source: PiSystemMessage; originals: SystemMessage[] } | undefined;
  const flushGroup = () => {
    if (!group) return;
    const { source, originals } = group;
    projected.push({
      message: projectSystemGroup(originals, source, hiddenDeclarations),
      originals,
    });
    group = undefined;
  };

  for (const original of messages) {
    const entry =
      original instanceof SystemMessage || original instanceof UserMessage
        ? getEntry(original.id)
        : undefined;
    const source = sourceSystemMessage(entry);
    if (entry && source && original instanceof SystemMessage) {
      if (group?.id !== entry.id) {
        flushGroup();
        group = { id: entry.id, source, originals: [] };
      }
      group.originals.push(original);
    } else {
      flushGroup();
      const parts =
        original instanceof UserMessage &&
        (entry?.type === "compaction" || entry?.type === "branch_summary")
          ? sessionEntryToContextMessages(entry).filter(({ role }) => role !== "system")
          : toPiMessages([original], { developerAsSystem: true });
      for (const message of parts) {
        projected.push({ message, originals: [original] });
      }
    }
  }
  flushGroup();

  const summaryIndex = projected.findIndex(({ message }) => message.role !== "system");
  const summary = projected[summaryIndex];
  if (summary?.message.role === "compactionSummary") {
    const prefix = projected.slice(0, summaryIndex);
    const snapshot = sourceSystemMessage(getEntry(summary.originals[0]!.id));
    const tools = snapshot?.toolsAdded?.filter(({ name }) => !hiddenDeclarations.has(name));
    const head =
      getCurrentSystemMessage(prefix.map(({ message }) => message)) ??
      createInitialSystemMessage(undefined, tools);
    if (head) {
      projected.splice(0, summaryIndex, {
        message: {
          ...head,
          ...(tools ? { toolsAdded: tools } : {}),
          timestamp: snapshot?.timestamp ?? head.timestamp,
        },
        originals: prefix.flatMap(({ originals }) => originals),
      });
    }
  }
  return projected;
}

function matchRequestTools(
  projected: ContextProjection[],
  tools: NonNullable<LlmInputPayload["tools"]>,
): void {
  const messages = projected.map(({ message }) => message);
  const declared = getCurrentTools(messages);
  const desired = tools.filter((tool) => tool instanceof FunctionToolDeclaration).map(toPiTool);
  const changes = getToolStateChanges(declared, desired);
  if (
    !changes.toolsAdded.length &&
    !changes.toolsRemoved.length &&
    declared.every(({ name }, index) => name === tools[index]?.name)
  )
    return;

  const last = messages.findLastIndex(({ role }) => role === "system");
  const system = projected[last];
  if (system?.message.role === "system") {
    const previous = getCurrentTools(messages.slice(0, last));
    system.message = {
      ...system.message,
      toolsAdded: [...desired],
      toolsRemoved: previous.map(({ name }) => ({ name })),
    };
  } else {
    const head = createInitialSystemMessage(undefined, [...desired]);
    if (head) projected.unshift({ message: head, originals: [] });
  }
}

function prepareContextProjection(
  payload: LlmInputPayload,
  sources: ContextSources,
): ContextProjection[] {
  const projected = projectContextMessages(payload.messages, sources);
  const leading = createInitialSystemMessage(payload.systemPrompt);
  if (leading) projected.unshift({ message: leading, originals: [] });
  matchRequestTools(projected, payload.tools ?? []);
  return projected;
}

export function projectPiRequestMessages(
  payload: LlmInputPayload,
  sources: ContextSources,
): PiMessage[] {
  return prepareContextProjection(payload, sources).map(({ message }) => message);
}

export function fromPiMessage(
  message: PiMessage,
  index: number,
  includeToolChanges = false,
): Message[] {
  if (message.role === "custom") return [customMessage(message)];
  const [entry] = convertToLlm([message]);
  if (entry === undefined) return [];
  switch (entry.role) {
    case "system": {
      const text =
        typeof entry.content === "string"
          ? entry.content
          : entry.content.map((block) => block.text).join("");
      const sections: Message[] = Object.entries(entry.sections ?? {}).map(([sectionId, value]) =>
        SystemMessage.create({
          sectionId,
          content: value === null ? [] : [TextBlock.create({ text: value })],
        }),
      );
      if (text)
        sections.unshift(
          SystemMessage.create({
            sectionId: index === 0 ? undefined : crypto.randomUUID(),
            content: [TextBlock.create({ text })],
          }),
        );
      if (includeToolChanges) {
        for (const { name } of entry.toolsRemoved ?? []) {
          sections.push(
            RemoveToolMessage.create({
              toolName: name,
              content: [],
              meta: new MessageMeta().set(SupplementaryField, true),
            }),
          );
        }
        for (const tool of entry.toolsAdded ?? []) {
          sections.push(
            AddToolMessage.create({
              tool: fromPiTool(tool),
              content: [TextBlock.create({ text: JSON.stringify(tool) })],
              meta: new MessageMeta().set(SupplementaryField, true),
            }),
          );
        }
      }
      return sections;
    }
    case "user":
      return [UserMessage.create({ content: fromPiContent(entry.content) })];
    case "toolResult":
      return [
        ToolResultMessage.create({
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          isError: entry.isError,
          content: fromPiContent(entry.content),
        }),
      ];
    case "assistant":
      return [fromPiAssistant(entry)];
  }
}

export async function transformExtensionContext(
  runner: ExtensionRunner,
  payload: LlmInputPayload,
  sources: ContextSources,
): Promise<LlmInputPayload> {
  if (!runner.hasHandlers("context") && !runner.hasHandlers("context_with_system")) return payload;

  const projected = prepareContextProjection(payload, sources);

  // Preserve native blocks, metadata, and replay state when an extension leaves a message unchanged.
  const originals = new Map<string, (readonly Message[])[]>();
  for (const { message, originals: native } of projected) {
    if (!native.length) continue;
    const key = messageKey(message);
    const matches = originals.get(key);
    if (matches) matches.push(native);
    else originals.set(key, [native]);
  }

  const output = await runner.emitContext(projected.map(({ message }) => message));
  return {
    messages: output.flatMap(
      (message, index) =>
        originals.get(messageKey(message))?.shift() ?? fromPiMessage(message, index),
    ),
    tools: getCurrentTools(output).map(fromPiTool),
  };
}

type PreviewFields = "entries" | "continue" | "context";
export type BoundaryEvent =
  | Omit<TurnEndEvent, PreviewFields>
  | Omit<AgentBeforeSettleEvent, PreviewFields>;

export function estimateSessionTokens(transcript: SessionManager): number {
  return estimateProjectedContextTokens(transcript.buildSessionProjection(), transcript.getBranch())
    .tokens;
}

export function appendBoundaryCompaction(transcript: SessionManager, draft: CompactionEntryDraft) {
  const id = transcript.appendCompaction(
    draft.summary,
    draft.firstKeptEntryId,
    estimateSessionTokens(transcript),
    draft.details,
    true,
    draft.usage,
  );
  const entry = transcript.getEntry(id);
  if (entry?.type !== "compaction") throw new Error("Compaction entry was not projected");
  return entry;
}

async function preview(
  transcript: SessionManager,
  drafts: readonly SessionBoundaryDraft[],
  pending: () => Promise<PiMessage[]>,
): Promise<BoundaryContextPreview> {
  let manager = transcript;
  if (drafts.length) {
    const header = transcript.getHeader();
    if (!header) throw new Error("The session header is missing");
    manager = SessionManager.inMemory(transcript.getCwd(), undefined, [
      header,
      ...transcript.getBranch(),
    ]);
    for (const draft of drafts) {
      switch (draft.type) {
        case "custom":
          manager.appendCustomEntry(draft.customType, draft.data);
          break;
        case "custom_message":
          manager.appendCustomMessageEntry(
            draft.customType,
            draft.content,
            draft.display,
            draft.details,
          );
          break;
        case "context_edit":
          manager.appendContextEdit(draft.targetId, draft.replacement);
          break;
        case "compaction":
          appendBoundaryCompaction(manager, draft);
          break;
      }
    }
  }
  const projection = manager.buildSessionProjection();
  const llmMessages = convertToLlm(projection.messages);
  const pendingMessages = await pending();
  const role = llmMessages.findLast(({ role }) => role !== "system")?.role;
  return {
    contextEntries: projection.entries,
    contextMessages: projection.messages,
    llmMessages,
    pendingMessages,
    canContinue: pendingMessages.length > 0 || (role !== undefined && role !== "assistant"),
  };
}

export async function dispatchBoundary(
  runner: ExtensionRunner,
  transcript: SessionManager,
  event: BoundaryEvent,
  pending: () => Promise<PiMessage[]>,
  append: (draft: SessionBoundaryDraft, resume: boolean) => void | Promise<void>,
): Promise<boolean> {
  if (!runner.hasHandlers(event.type)) return false;
  const result = await runner.emitBoundary(event, (drafts) => preview(transcript, drafts, pending));
  const resume = result.continue && result.context.canContinue;
  for (const draft of result.entries) {
    await append(draft, resume);
  }
  if (result.continue && !resume) {
    runner.emitError({
      extensionPath: "<boundary>",
      event: event.type,
      error: `${event.type} requested continuation without runnable model context`,
    });
  }
  return resume;
}
