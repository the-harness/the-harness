import { MessageMeta, type LlmChunk } from "@harness/llm";
import type { FieldKey, SerializedVariant } from "@harness/variants";

// Field names predate the split from ui-chat and are already stored with messages.
const fields = globalThis as unknown as Record<string, FieldKey<MessageMeta, any> | undefined>;
export const ChatDurationField: FieldKey<MessageMeta, number> = (fields[
  "__HARNESS_UI_CHAT_DURATION_FIELD__"
] ??= MessageMeta.defineField<number, typeof MessageMeta>("core:ui-chat:duration-ms"));
export const ChatTimestampField: FieldKey<MessageMeta, number> = (fields[
  "__HARNESS_UI_CHAT_TIMESTAMP_FIELD__"
] ??= MessageMeta.defineField<number, typeof MessageMeta>("core:ui-chat:timestamp"));
export const TurnGroupField: FieldKey<MessageMeta, string> = (fields[
  "__HARNESS_UI_CHAT_TURN_GROUP_FIELD__"
] ??= MessageMeta.defineField<string, typeof MessageMeta>("core:ui-chat:turn-group"));

export interface ChatRunOptions {
  readonly modelId?: string;
  readonly presetId?: string;
}

// A run is replayed from core types: committed messages (consumed input, each step's final assistant message, tool results) and the chunks of the step in progress.
export type ChatStreamEvent =
  | { readonly type: "message"; readonly message: SerializedVariant }
  | { readonly type: "chunk"; readonly chunk: Exclude<LlmChunk, { readonly type: "finish" }> }
  | { readonly type: "tool_output"; readonly id: string; readonly delta: string }
  | { readonly type: "error"; readonly message: string };

export interface ChatRunState {
  readonly runId: string | null;
  readonly before: number;
  readonly notice: string;
}

export interface ChatMessagesPage {
  readonly messages: readonly SerializedVariant[];
  readonly nextBefore: number | null;
  readonly hasMore: boolean;
}
