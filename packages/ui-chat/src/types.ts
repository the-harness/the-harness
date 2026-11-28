import type { AgentPresetIcon } from "@harness/agent-preset";
import type { ChatRunOptions, ChatRunState } from "@harness/chat-session/types";
import type { ImageBlock, Message } from "@harness/llm";
import { z } from "zod";

export {
  ChatDurationField,
  ChatTimestampField,
  TurnGroupField,
  type ChatMessagesPage,
  type ChatRunOptions,
  type ChatRunState,
  type ChatStreamEvent,
} from "@harness/chat-session/types";

export interface ToolDiffLine {
  readonly type: "add" | "del" | "ctx";
  readonly text: string;
}

export interface ToolCallItem {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly target?: string;
  readonly range?: string;
  readonly command?: string;
  readonly output?: string;
  readonly added?: number;
  readonly removed?: number;
  readonly diff?: readonly ToolDiffLine[];
  readonly status?: "running" | "ok" | "error";
  readonly duration?: string;
}

export type ActivityItem =
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly text: string;
      readonly duration?: string;
      readonly streaming?: boolean;
    }
  | { readonly kind: "tool"; readonly id: string; readonly tool: ToolCallItem };

export type ChatBlock =
  | ActivityItem
  | { readonly kind: "text"; readonly id: string; readonly text: string; readonly streaming?: boolean };

export interface TurnFileChange {
  readonly path: string;
  readonly status: "M" | "A" | "D";
  readonly added: number;
  readonly removed: number;
}

// One transcript row: a user prompt, an assistant turn (its steps merged), or another message kind kept as `source`.
export interface SessionMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly source?: Message;
  readonly images?: readonly ImageBlock[];
  readonly activities?: readonly ActivityItem[];
  readonly changes?: readonly TurnFileChange[];
  readonly timestamp?: number;
  readonly durationMs?: number;
  readonly streaming?: boolean;
}

export type SyncListTarget = "pending" | "queue";

export interface ChatPreset {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: AgentPresetIcon;
}

export interface ChatModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export const ChatRunStateSchema: z.ZodType<ChatRunState> = z.object({
  runId: z.string().nullable(),
  before: z.number().int().nonnegative(),
  notice: z.string(),
});

export const ChatRunOptionsSchema: z.ZodType<ChatRunOptions> = z.object({
  modelId: z.string().optional(),
  presetId: z.string().optional(),
});
