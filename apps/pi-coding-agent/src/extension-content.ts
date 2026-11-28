import {
  convertToLlm,
  type CompactionResult,
  type ContextEditEntry,
  type ExtensionRunner,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SupplementaryField } from "@harness/agent-loop";
import {
  AssistantMessage,
  DeveloperMessage,
  extractText,
  ImageBlock,
  Message,
  MessageMeta,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type ContentBlock,
  type LlmResponse,
} from "@harness/llm";
import { CompactionSummaryMessage } from "@harness/pi-compaction";
import { variant } from "@harness/variants";

export type PiMessage = Parameters<ExtensionRunner["emitContext"]>[0][number];
export type PiAssistant = Extract<PiMessage, { role: "assistant" }>;
export type PiCustomMessage = Extract<PiMessage, { role: "custom" }>;
type PiContent = Awaited<ReturnType<ToolDefinition["execute"]>>["content"];
export type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type PiToolResultData = Partial<Pick<PiToolResult, "details" | "structuredContent" | "usage">> & {
  readonly nestedCalls?: Extract<PiMessage, { role: "toolResult" }>["nestedCalls"];
};
type PiBashExecution = Extract<PiMessage, { role: "bashExecution" }>;

const Timestamp = MessageMeta.defineField<number, typeof MessageMeta>("pi:cli:timestamp");
const ToolResultData = MessageMeta.defineField<string, typeof MessageMeta>(
  "pi:cli:tool-result-data",
);
const AssistantResult = MessageMeta.defineField<
  Pick<PiAssistant, "usage" | "stopReason" | "errorMessage"> &
    Partial<
      Pick<
        PiAssistant,
        "api" | "responseId" | "responseModel" | "thinkingLevel" | "providerThinkingLevel"
      >
    >,
  typeof MessageMeta
>("pi:cli:assistant-result");
const TextSignatures = MessageMeta.defineField<readonly (string | null)[], typeof MessageMeta>(
  "pi:cli:assistant-text-signatures",
);
export const BashExecution = MessageMeta.defineField<PiBashExecution, typeof MessageMeta>(
  "pi:cli:bash-execution",
);
const CustomMessage = MessageMeta.defineField<
  Pick<PiCustomMessage, "customType" | "display"> & {
    readonly stringContent: boolean;
    readonly detailsJson?: string;
  },
  typeof MessageMeta
>("pi:cli:custom-message");

export class ExtensionEntry extends Message {
  declare readonly customType: string;
  declare readonly dataJson?: string;
}
variant("pi:cli:custom-entry")(ExtensionEntry);

export function extensionEntry(customType: string, data?: unknown): ExtensionEntry {
  return ExtensionEntry.create({
    customType,
    dataJson: JSON.stringify(data),
    meta: new MessageMeta().set(SupplementaryField, true),
  });
}

export class ContextEditMessage extends Message {
  declare readonly targetMessageId?: string;
  declare readonly replacement: ContextEditEntry["replacement"];
}
variant("pi:cli:context-edit")(ContextEditMessage);

export function contextEditMessage(
  entry: ContextEditEntry,
  targetMessageId?: string,
): ContextEditMessage {
  return ContextEditMessage.create({
    targetMessageId,
    replacement: entry.replacement,
    meta: new MessageMeta().set(SupplementaryField, true),
  });
}

export class CompactionCheckpoint extends Message {}
variant("pi:cli:compaction-checkpoint")(CompactionCheckpoint);

export type PiUsageEntry = Extract<SessionEntry, { type: "usage" }>;

export class SessionUsage extends Message {
  declare readonly kind: string;
  declare readonly provider: string;
  declare readonly model: string;
  declare readonly usage: PiUsageEntry["usage"];
  declare readonly note?: string;
}
variant("pi:cli:usage")(SessionUsage);

export function sessionUsage({ kind, provider, model, usage, note }: PiUsageEntry): SessionUsage {
  return SessionUsage.create({
    kind,
    provider,
    model,
    usage,
    note,
    meta: new MessageMeta().set(SupplementaryField, true),
  });
}

export function includeInModelContext(message: Message): boolean {
  return (
    !(
      message instanceof ExtensionEntry ||
      message instanceof ContextEditMessage ||
      message instanceof CompactionCheckpoint ||
      message instanceof SessionUsage
    ) && !message.meta.get(BashExecution)?.excludeFromContext
  );
}

export function projectModelMessages(messages: readonly Message[], history = messages): Message[] {
  const edits = new Map<string, ContextEditEntry["replacement"]>();
  for (const message of history) {
    if (message instanceof ContextEditMessage && message.targetMessageId) {
      edits.set(message.targetMessageId, message.replacement);
    }
  }
  return messages.filter(includeInModelContext).flatMap((message) => {
    const replacement = edits.get(message.id);
    if (replacement === undefined) return [message];
    if (replacement === null) return [];

    const { content } = replacement;
    if (message instanceof UserMessage) {
      const meta = new MessageMeta(message.meta);
      const custom = meta.get(CustomMessage);
      if (custom)
        meta.set(CustomMessage, { ...custom, stringContent: typeof content === "string" });
      return [
        UserMessage.create({
          id: message.id,
          meta,
          content: fromPiContent(content as string | PiContent),
        }),
      ];
    }
    const [original] = toPiMessages([message]);
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    if (message instanceof AssistantMessage && original?.role === "assistant") {
      return [fromPiAssistant({ ...original, content: blocks as PiAssistant["content"] }, message)];
    }
    if (message instanceof ToolResultMessage && original?.role === "toolResult") {
      return [
        replacePiToolResult(message, original, { ...original, content: blocks as PiContent }),
      ];
    }
    return [message];
  });
}

export interface CompactionProjection {
  readonly afterMessageId: string | undefined;
  readonly firstKeptMessageId: string | undefined;
  readonly tokensBefore: number;
  readonly fromExtension: boolean;
  readonly details?: unknown;
  readonly usage?: CompactionResult["usage"];
}

export const CompactionProjectionField = MessageMeta.defineField<
  CompactionProjection,
  typeof MessageMeta
>("pi:cli:compaction");

export function bashMessage(execution: PiBashExecution, meta: MessageMeta): UserMessage {
  const content = convertToLlm([execution]).flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string") return fromPiContent(message.content);
    return fromPiContent(
      message.content.filter((part) => part.type === "text" || part.type === "image"),
    );
  });
  return UserMessage.create({ content, meta: meta.set(BashExecution, execution) });
}

export function stampMessage(message: Message, timestamp = Date.now()): void {
  if (message.meta.get(Timestamp) === undefined) message.meta.set(Timestamp, timestamp);
}

export function stampToolResultData(message: Message, data: PiToolResultData): void {
  if (Object.values(data).some((value) => value !== undefined)) {
    message.meta.set(ToolResultData, JSON.stringify(data));
  }
}

export function readToolResultData(message: Message): PiToolResultData {
  const stored = message.meta.get(ToolResultData);
  return stored === undefined ? {} : JSON.parse(stored);
}

export function replacePiToolResult(
  previous: ToolResultMessage,
  original: Extract<PiMessage, { role: "toolResult" }>,
  edited: Extract<PiMessage, { role: "toolResult" }>,
): ToolResultMessage {
  const meta = new MessageMeta(previous.meta);
  meta.delete(ToolResultData);
  const result = ToolResultMessage.create({
    id: previous.id,
    meta,
    toolCallId: edited.toolCallId,
    toolName: edited.toolName,
    content: fromPiContent(edited.content),
    isError: edited.isError,
  });
  stampToolResultData(result, {
    details: edited.details,
    usage: edited.usage,
    nestedCalls: edited.nestedCalls,
    structuredContent:
      edited.content === original.content
        ? readToolResultData(previous).structuredContent
        : undefined,
  });
  return result;
}

export function stampImportedMessage(message: Message, original: PiMessage): void {
  stampMessage(message, original.timestamp);
  if (original.role === "assistant") {
    message.meta.set(AssistantResult, {
      api: original.api,
      responseId: original.responseId,
      responseModel: original.responseModel,
      thinkingLevel: original.thinkingLevel,
      providerThinkingLevel: original.providerThinkingLevel,
      usage: original.usage,
      stopReason: original.stopReason,
      errorMessage: original.errorMessage,
    });
    const signatures = original.content.map((block) =>
      block.type === "text" ? (block.textSignature ?? null) : null,
    );
    if (signatures.some(Boolean)) message.meta.set(TextSignatures, signatures);
  }
  if (original.role === "toolResult") {
    stampToolResultData(message, {
      details: original.details,
      usage: original.usage,
      nestedCalls: original.nestedCalls,
    });
  }
  if (original.role === "custom") {
    const { customType, display, details, content } = original;
    message.meta.set(CustomMessage, {
      customType,
      display,
      detailsJson: JSON.stringify(details),
      stringContent: typeof content === "string",
    });
  }
}

export function customMessage(original: PiCustomMessage, supplementary = true): UserMessage {
  const message = UserMessage.create({
    content: fromPiContent(original.content),
    meta: new MessageMeta().set(SupplementaryField, supplementary),
  });
  stampImportedMessage(message, original);
  return message;
}

export function replacePiUserMessage(
  previous: UserMessage,
  edited: Extract<PiMessage, { role: "user" | "custom" }>,
): UserMessage {
  const message = UserMessage.create({
    id: previous.id,
    content: fromPiContent(edited.content),
    meta: new MessageMeta(previous.meta).set(Timestamp, edited.timestamp),
  });
  stampImportedMessage(message, edited);
  return message;
}

export function piUsage(usage?: LlmResponse["usage"]): PiAssistant["usage"] {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function stampResponse(response: LlmResponse, timestamp: number): void {
  const reason = response.stopReason;
  const stopReason =
    reason === "tool_calls" ? "toolUse" : reason === "max_tokens" ? "length" : reason;
  stampMessage(response.message, timestamp);
  if (!response.message.meta.has(AssistantResult)) {
    response.message.meta.set(AssistantResult, {
      usage: piUsage(response.usage),
      stopReason,
      errorMessage: response.error?.message,
    });
  }
}

export function fromPiAssistant(
  original: PiAssistant,
  previous?: AssistantMessage,
): AssistantMessage {
  const meta = previous ? new MessageMeta(previous.meta) : undefined;
  meta?.delete(TextSignatures);
  const message = AssistantMessage.create({
    id: previous?.id,
    meta,
    replayState: previous?.replayState,
    provider: original.provider,
    model: original.model,
    content: original.content.map((block) => {
      switch (block.type) {
        case "text":
          return TextBlock.create({ text: block.text });
        case "thinking":
          return ThinkingBlock.create({
            thinking: block.thinking,
            signature: block.thinkingSignature,
          });
        case "toolCall":
          return ToolCallBlock.create({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
            thoughtSignature: block.thoughtSignature,
          });
      }
    }),
  });
  stampImportedMessage(message, original);
  return message;
}

export function fromPiContent(content: string | PiContent): ContentBlock[] {
  if (typeof content === "string") return [TextBlock.create({ text: content })];
  return content.map((block) =>
    block.type === "text"
      ? TextBlock.create({ text: block.text })
      : ImageBlock.create({ data: block.data, mimeType: block.mimeType }),
  );
}

export function toPiContent(content: readonly ContentBlock[]): PiContent {
  const blocks: PiContent = [];
  for (const block of content) {
    if (block instanceof TextBlock) blocks.push({ type: "text", text: block.text });
    if (block instanceof ImageBlock && block.data !== undefined) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

export function parseToolInput(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = value.trim() ? JSON.parse(value) : {};
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function toPiMessages(
  messages: readonly Message[],
  options?: { readonly developerAsSystem?: boolean },
): PiMessage[] {
  const result: PiMessage[] = [];
  for (const message of messages) {
    const execution = message.meta.get(BashExecution);
    if (execution) {
      result.push(execution);
      continue;
    }
    const timestamp = message.meta.get(Timestamp) ?? 0;
    if (message instanceof CompactionSummaryMessage && message.summary !== undefined) {
      result.push({
        role: "compactionSummary",
        summary: message.summary,
        tokensBefore: message.meta.get(CompactionProjectionField)?.tokensBefore ?? 0,
        timestamp,
      });
    } else if (message instanceof UserMessage) {
      const custom = message.meta.get(CustomMessage);
      if (custom) {
        const { customType, display, detailsJson, stringContent } = custom;
        const details: unknown = detailsJson === undefined ? undefined : JSON.parse(detailsJson);
        const content = stringContent ? extractText(message.content) : toPiContent(message.content);
        result.push({ role: "custom", customType, content, display, details, timestamp });
      } else {
        result.push({ role: "user", content: toPiContent(message.content), timestamp });
      }
    } else if (message instanceof ToolResultMessage) {
      const { details, usage, nestedCalls } = readToolResultData(message);
      result.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: toPiContent(message.content),
        details,
        usage,
        nestedCalls,
        isError: message.isError ?? false,
        timestamp,
      });
    } else if (message instanceof AssistantMessage) {
      const content: Extract<PiMessage, { role: "assistant" }>["content"] = [];
      const signatures = message.meta.get(TextSignatures);
      for (const [index, block] of message.content.entries()) {
        if (block instanceof TextBlock) {
          content.push({
            type: "text",
            text: block.text,
            textSignature: signatures?.[index] ?? undefined,
          });
        }
        if (block instanceof ThinkingBlock) {
          content.push({
            type: "thinking",
            thinking: block.thinking,
            thinkingSignature: block.signature,
          });
        }
        if (block instanceof ToolCallBlock) {
          content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parseToolInput(block.arguments) ?? {},
            thoughtSignature: block.thoughtSignature,
          });
        }
      }
      result.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: message.provider,
        model: message.model,
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        usage: piUsage(),
        ...message.meta.get(AssistantResult),
        timestamp,
      });
    } else if (message instanceof DeveloperMessage && options?.developerAsSystem) {
      result.push({ role: "system", content: extractText(message.content), timestamp });
    } else if (message instanceof SystemMessage) {
      const text = extractText(message.content);
      result.push(
        message.sectionId === undefined
          ? {
              role: "system",
              content: text,
              timestamp,
            }
          : {
              role: "system",
              content: "",
              sections: { [message.sectionId]: message.content.length === 0 ? null : text },
              timestamp,
            },
      );
    }
  }
  return result;
}
