import type { HookSlot } from "@harness/hooks";
import { MessageMeta, type LlmRequest, type LlmResponse, type LlmStreamChunk } from "@harness/llm";

export const SupplementaryField = MessageMeta.defineField<boolean, typeof MessageMeta>(
  "core:agent-loop:supplementary",
);

export interface LlmInputPayload {
  readonly systemPrompt?: string;
  readonly tools?: LlmRequest["tools"];
  readonly messages: LlmRequest["messages"];
}

export interface ContextTransformInput {
  readonly stopBeforeIndex?: number;
}

export interface HandleOutputInput {
  readonly response: LlmResponse;
  readonly signal: AbortSignal;
}

export interface AgentLoopHooks {
  readonly shouldSend: HookSlot<void, boolean>;
  readonly transformContext: HookSlot<ContextTransformInput, Promise<LlmInputPayload>>;
  readonly streamChunk: HookSlot<LlmStreamChunk, void>;
  readonly handleOutput: HookSlot<HandleOutputInput, Promise<void>>;
  readonly handleError: HookSlot<unknown, Promise<void>>;
}

export type LoopStopReason = "completed" | "aborted" | "max_steps" | "max_tokens";

export interface AgentLoopOptions {
  readonly maxSteps?: number;
  readonly sessionId?: string;
}
