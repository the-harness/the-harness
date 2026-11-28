import type {
  LlmChunk,
  LlmError,
  LlmModelInfo,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmUsage,
  Modality,
  ToolDeclaration,
  ToolResultMessage,
} from "@harness/llm";
import type { MaybeRefOrGetter } from "reactivity";

export interface MockModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean | readonly string[];
  readonly inputModalities?: readonly Modality[];
  readonly outputModalities?: readonly Modality[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface MockToolCallSpec {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly thoughtSignature?: string;
}

export interface MockReply {
  readonly text?: string;
  readonly thinking?: string;
  readonly thinkingSignature?: string;
  readonly toolCalls?: readonly MockToolCallSpec[];
  readonly stopReason?: LlmStopReason;
  readonly error?: LlmError;
  readonly usage?: Partial<LlmUsage>;
  readonly replayState?: unknown;
  readonly delayMs?: number;
}

export interface MockContext {
  readonly request: LlmRequest;
  readonly callIndex: number;
  readonly sessionCallIndex: number;
  readonly lastUserText: string;
  readonly toolResults: readonly ToolResultMessage[];
  readonly allToolResults: readonly ToolResultMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly signal: AbortSignal | undefined;
  text(delta: string): this;
  think(
    delta: string,
    options?: { readonly signature?: string; readonly redacted?: boolean },
  ): this;
  toolCall(
    name: string,
    args?: unknown,
    options?: { readonly id?: string; readonly thoughtSignature?: string },
  ): this;
  chunk(chunk: LlmChunk, delayMs?: number): this;
  usage(usage: Partial<LlmUsage>): this;
  replayState(state: unknown): this;
  stopReason(reason: LlmStopReason): this;
  fail(message: string, options?: { readonly retryable?: boolean }): never;
  sleep(ms: number): Promise<void>;
  flush(): Promise<void>;
  waitForAbort(): Promise<void>;
}

export type MockHandlerReturn = string | MockReply | void;

export type MockHandler = (ctx: MockContext) => MockHandlerReturn | Promise<MockHandlerReturn>;

export type MockStep = string | MockReply | MockHandler;

export type MockNext = () => Promise<void>;

export type MockMiddleware = (
  ctx: MockContext,
  next: MockNext,
) => MockHandlerReturn | Promise<MockHandlerReturn>;

export type MockChunkSize = number | { readonly min: number; readonly max: number };

export interface MockRequestRecord {
  readonly index: number;
  readonly sessionCallIndex: number;
  readonly request: LlmRequest;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly response?: LlmResponse;
  readonly error?: LlmError;
}

export interface MockActiveStream {
  readonly index: number;
  readonly request: LlmRequest;
  readonly startedAt: number;
}

export interface MockTranscriptProblem {
  readonly callIndex: number;
  readonly message: string;
}

export interface ScriptedMockLlmOptions {
  readonly providerId?: string;
  readonly models?: MaybeRefOrGetter<readonly (MockModelConfig | LlmModelInfo)[]>;
  readonly handler?: MockHandler;
  readonly chunkSize?: MaybeRefOrGetter<MockChunkSize>;
  readonly chunkDelayMs?: MaybeRefOrGetter<number>;
  readonly firstTokenDelayMs?: MaybeRefOrGetter<number>;
  readonly defaultContextWindow?: number;
  readonly defaultMaxTokens?: number;
}
