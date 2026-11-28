import {
  AssistantMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  type ContentBlock,
  type LlmChunk,
  type LlmError,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmStream,
  type LlmUsage,
  type ToolDeclaration,
  type ToolResultMessage,
} from "@harness/llm";
import { toValue, type MaybeRefOrGetter } from "reactivity";
import type { MockChunkSize, MockContext, MockHandlerReturn, MockReply } from "./types.ts";
import {
  abortableSleep,
  estimateUsage,
  extractRequestFacts,
  MockAbortError,
  MockLlmError,
  sliceString,
  waitUntilAborted,
} from "./utils.ts";

interface QueuedChunk {
  readonly chunk: Exclude<LlmChunk, { readonly type: "finish" }>;
  readonly delayMs?: number;
}

export interface MockStreamPacing {
  readonly chunkSize: MaybeRefOrGetter<MockChunkSize>;
  readonly chunkDelayMs: MaybeRefOrGetter<number>;
  readonly firstTokenDelayMs: MaybeRefOrGetter<number>;
}

export class MockContextImpl implements MockContext {
  readonly request: LlmRequest;
  readonly callIndex: number;
  readonly sessionCallIndex: number;
  readonly lastUserText: string;
  readonly toolResults: readonly ToolResultMessage[];
  readonly allToolResults: readonly ToolResultMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly signal: AbortSignal | undefined;

  private readonly _pacing: MockStreamPacing;
  private readonly _enqueue: (item: QueuedChunk) => void;
  private readonly _flush: () => Promise<void>;
  private _explicitStopReason: LlmStopReason | undefined;
  private _explicitUsage: Partial<LlmUsage> | undefined;
  private _explicitReplayState: unknown;
  private _explicitError: LlmError | undefined;
  private _nextToolIndex = 0;

  constructor(
    request: LlmRequest,
    callIndex: number,
    sessionCallIndex: number,
    pacing: MockStreamPacing,
    enqueue: (item: QueuedChunk) => void,
    flush: () => Promise<void>,
  ) {
    this.request = request;
    this.callIndex = callIndex;
    this.sessionCallIndex = sessionCallIndex;
    this.tools = request.tools ?? [];
    this.signal = request.signal;
    this._pacing = pacing;
    this._enqueue = enqueue;
    this._flush = flush;

    const facts = extractRequestFacts(request.messages);
    this.lastUserText = facts.lastUserText;
    this.toolResults = facts.toolResults;
    this.allToolResults = facts.allToolResults;
  }

  get explicitStopReason(): LlmStopReason | undefined {
    return this._explicitStopReason;
  }

  get explicitUsage(): Partial<LlmUsage> | undefined {
    return this._explicitUsage;
  }

  get explicitReplayState(): unknown {
    return this._explicitReplayState;
  }

  get explicitError(): LlmError | undefined {
    return this._explicitError;
  }

  text(delta: string): this {
    if (delta.length === 0) {
      return this;
    }
    const size = toValue(this._pacing.chunkSize);
    for (const part of sliceString(delta, size)) {
      this._enqueue({ chunk: { type: "text_delta", delta: part } });
    }
    return this;
  }

  think(
    delta: string,
    options?: { readonly signature?: string; readonly redacted?: boolean },
  ): this {
    if (delta.length === 0 && options?.signature === undefined && options?.redacted === undefined) {
      return this;
    }
    if (options?.signature !== undefined || options?.redacted !== undefined) {
      this._thinkingMeta = {
        signature: options.signature,
        redacted: options.redacted,
      };
    }
    const size = toValue(this._pacing.chunkSize);
    const parts = delta.length > 0 ? sliceString(delta, size) : [];
    for (const part of parts) {
      this._enqueue({ chunk: { type: "thinking_delta", delta: part } });
    }
    return this;
  }

  private _thinkingMeta: { signature?: string; redacted?: boolean } | undefined;

  get thinkingMeta(): { readonly signature?: string; readonly redacted?: boolean } | undefined {
    return this._thinkingMeta;
  }

  toolCall(
    name: string,
    args: unknown = {},
    options?: { readonly id?: string; readonly thoughtSignature?: string },
  ): this {
    const id = options?.id ?? `call_${this.callIndex}_${++this._nextToolIndex}`;
    const serialized = typeof args === "string" ? args : JSON.stringify(args ?? {});
    if (options?.thoughtSignature !== undefined) {
      this._toolThoughtSignatures.set(id, options.thoughtSignature);
    }
    this._enqueue({ chunk: { type: "tool_call_start", id, name } });
    const size = toValue(this._pacing.chunkSize);
    for (const part of sliceString(serialized, size)) {
      this._enqueue({ chunk: { type: "tool_call_delta", id, delta: part } });
    }
    this._enqueue({
      chunk: { type: "tool_call_end", id, name, arguments: serialized },
    });
    return this;
  }

  private readonly _toolThoughtSignatures = new Map<string, string>();

  getToolThoughtSignature(id: string): string | undefined {
    return this._toolThoughtSignatures.get(id);
  }

  chunk(chunk: LlmChunk, delayMs?: number): this {
    if (chunk.type === "finish") {
      this._explicitStopReason = chunk.response.stopReason;
      this._explicitUsage = chunk.response.usage;
      this._explicitReplayState = chunk.response.message.replayState;
      this._explicitError = chunk.response.error;
      return this;
    }
    this._enqueue({ chunk, delayMs });
    return this;
  }

  usage(usage: Partial<LlmUsage>): this {
    this._explicitUsage = { ...this._explicitUsage, ...usage };
    return this;
  }

  replayState(state: unknown): this {
    this._explicitReplayState = state;
    return this;
  }

  stopReason(reason: LlmStopReason): this {
    this._explicitStopReason = reason;
    return this;
  }

  fail(message: string, options?: { readonly retryable?: boolean }): never {
    throw new MockLlmError(message, options);
  }

  async sleep(ms: number): Promise<void> {
    await this._flush();
    await abortableSleep(ms, this.signal);
  }

  async flush(): Promise<void> {
    await this._flush();
  }

  async waitForAbort(): Promise<void> {
    await this._flush();
    await waitUntilAborted(this.signal);
  }

  applyReply(reply: MockReply): void {
    if (reply.thinking !== undefined) {
      this.think(reply.thinking, { signature: reply.thinkingSignature });
    }
    if (reply.text !== undefined) {
      this.text(reply.text);
    }
    if (reply.toolCalls !== undefined) {
      for (const tc of reply.toolCalls) {
        this.toolCall(tc.name, tc.arguments, {
          id: tc.id,
          thoughtSignature: tc.thoughtSignature,
        });
      }
    }
    if (reply.usage !== undefined) {
      this.usage(reply.usage);
    }
    if (reply.replayState !== undefined) {
      this.replayState(reply.replayState);
    }
    if (reply.stopReason !== undefined) {
      this.stopReason(reply.stopReason);
    }
    if (reply.error !== undefined) {
      this._explicitError = reply.error;
      if (this._explicitStopReason === undefined) {
        this._explicitStopReason = "error";
      }
    }
  }
}

export async function applyMockHandlerReturn(
  ctx: MockContextImpl,
  returned: MockHandlerReturn,
): Promise<void> {
  if (returned === undefined) {
    return;
  }
  if (typeof returned === "string") {
    ctx.text(returned);
    return;
  }
  if (returned.delayMs !== undefined && returned.delayMs > 0) {
    await ctx.sleep(returned.delayMs);
  }
  ctx.applyReply(returned);
}

export interface RunMockStreamOptions {
  readonly request: LlmRequest;
  readonly callIndex: number;
  readonly sessionCallIndex: number;
  readonly pacing: MockStreamPacing;
  readonly sessionPrefixCache: Map<string, readonly string[]>;
  readonly execute: (ctx: MockContextImpl) => Promise<MockHandlerReturn>;
  readonly onFinish: (response: LlmResponse) => void;
}

export function runMockStream(options: RunMockStreamOptions): LlmStream {
  const { request, callIndex, sessionCallIndex, pacing, sessionPrefixCache, execute, onFinish } =
    options;
  const signal = request.signal;

  const emittedChunks: LlmChunk[] = [];
  const waiters: Array<(result: IteratorResult<LlmChunk>) => void> = [];
  let finished = false;

  let settleResult!: (res: LlmResponse) => void;
  const resultPromise = new Promise<LlmResponse>((resolve) => {
    settleResult = resolve;
  });

  const pushStreamChunk = (chunk: LlmChunk) => {
    if (finished) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: chunk, done: false });
    } else {
      emittedChunks.push(chunk);
    }
    if (chunk.type === "finish") {
      finished = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
    }
  };

  const outboundQueue: QueuedChunk[] = [];
  let pacerRunning = false;
  let firstChunkSent = false;
  let aborted = Boolean(signal?.aborted);
  const flushWaiters: Array<() => void> = [];

  const contentBlocks: ContentBlock[] = [];
  let pendingText = "";
  let pendingThinking = "";
  const activeToolCalls = new Map<string, { name: string; args: string }>();
  let hasToolCalls = false;

  let ctxRef!: MockContextImpl;

  const flushPendingText = () => {
    if (pendingText.length > 0) {
      contentBlocks.push(TextBlock.create({ text: pendingText }));
      pendingText = "";
    }
  };

  const flushPendingThinking = () => {
    if (pendingThinking.length > 0) {
      const meta = ctxRef.thinkingMeta;
      contentBlocks.push(
        ThinkingBlock.create({
          thinking: pendingThinking,
          ...(meta?.signature !== undefined ? { signature: meta.signature } : {}),
          ...(meta?.redacted !== undefined ? { redacted: meta.redacted } : {}),
        }),
      );
      pendingThinking = "";
    }
  };

  const recordChunkToBlocks = (chunk: Exclude<LlmChunk, { readonly type: "finish" }>) => {
    switch (chunk.type) {
      case "text_delta":
        flushPendingThinking();
        pendingText += chunk.delta;
        break;
      case "thinking_delta":
        flushPendingText();
        pendingThinking += chunk.delta;
        break;
      case "tool_call_start":
        flushPendingThinking();
        flushPendingText();
        hasToolCalls = true;
        activeToolCalls.set(chunk.id, { name: chunk.name, args: "" });
        break;
      case "tool_call_delta": {
        const active = activeToolCalls.get(chunk.id);
        if (active !== undefined) {
          active.args += chunk.delta;
        }
        break;
      }
      case "tool_call_end": {
        const active = activeToolCalls.get(chunk.id);
        activeToolCalls.delete(chunk.id);
        const args = chunk.arguments || active?.args || "{}";
        const thoughtSignature = ctxRef.getToolThoughtSignature(chunk.id);
        contentBlocks.push(
          ToolCallBlock.create({
            id: chunk.id,
            name: chunk.name,
            arguments: args,
            ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
          }),
        );
        break;
      }
    }
  };

  const resolveFlushWaiters = () => {
    if (outboundQueue.length === 0 && !pacerRunning) {
      while (flushWaiters.length > 0) {
        flushWaiters.shift()!();
      }
    }
  };

  const drainOutbound = async () => {
    if (pacerRunning) return;
    pacerRunning = true;
    try {
      while (outboundQueue.length > 0 && !aborted && !finished) {
        const item = outboundQueue.shift()!;
        const delayMs =
          item.delayMs !== undefined
            ? item.delayMs
            : firstChunkSent
              ? toValue(pacing.chunkDelayMs)
              : toValue(pacing.firstTokenDelayMs);
        if (delayMs > 0) {
          try {
            await abortableSleep(delayMs, signal);
          } catch {
            aborted = true;
            break;
          }
        }
        if (aborted || finished) break;
        firstChunkSent = true;
        recordChunkToBlocks(item.chunk);
        pushStreamChunk(item.chunk);
      }
    } finally {
      pacerRunning = false;
      resolveFlushWaiters();
    }
  };

  const enqueueOutbound = (item: QueuedChunk) => {
    if (aborted || finished) return;
    outboundQueue.push(item);
    void drainOutbound();
  };

  const flushOutbound = async (): Promise<void> => {
    if (aborted || finished) return;
    if (outboundQueue.length === 0 && !pacerRunning) {
      return;
    }
    await new Promise<void>((resolve) => {
      flushWaiters.push(resolve);
      void drainOutbound();
    });
  };

  ctxRef = new MockContextImpl(
    request,
    callIndex,
    sessionCallIndex,
    pacing,
    enqueueOutbound,
    flushOutbound,
  );

  const onAbort = () => {
    aborted = true;
    outboundQueue.length = 0;
    while (flushWaiters.length > 0) {
      flushWaiters.shift()!();
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const finalize = (stopReason: LlmStopReason, error?: LlmError) => {
    signal?.removeEventListener("abort", onAbort);
    flushPendingThinking();
    flushPendingText();

    const estimated = estimateUsage(request, contentBlocks, sessionPrefixCache);
    const explicitUsage = ctxRef.explicitUsage;
    const inputTokens = explicitUsage?.inputTokens ?? estimated.inputTokens;
    const outputTokens = explicitUsage?.outputTokens ?? estimated.outputTokens;
    const cacheReadTokens = explicitUsage?.cacheReadTokens ?? estimated.cacheReadTokens;
    const cacheWriteTokens = explicitUsage?.cacheWriteTokens ?? estimated.cacheWriteTokens;
    const usage: LlmUsage = {
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      totalTokens:
        explicitUsage?.totalTokens ??
        inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    };

    const replayState = ctxRef.explicitReplayState;
    const response: LlmResponse = {
      message: AssistantMessage.create({
        content: contentBlocks,
        provider: request.provider,
        model: request.model,
        ...(replayState !== undefined ? { replayState } : {}),
      }),
      stopReason,
      usage,
      ...(error !== undefined ? { error } : {}),
    };

    onFinish(response);
    settleResult(response);
    pushStreamChunk({ type: "finish", response });
  };

  void (async () => {
    if (aborted) {
      finalize("aborted");
      return;
    }

    let caughtError: unknown;
    let hasError = false;
    try {
      const returned = await execute(ctxRef);
      if (!aborted) {
        await applyMockHandlerReturn(ctxRef, returned);
      }
      if (!aborted) {
        await flushOutbound();
      }
    } catch (err) {
      caughtError = err;
      hasError = true;
      if (!aborted) {
        await flushOutbound();
      }
    }

    if (aborted || signal?.aborted || caughtError instanceof MockAbortError) {
      finalize("aborted");
      return;
    }

    if (hasError) {
      const llmError: LlmError =
        caughtError instanceof MockLlmError
          ? {
              message: caughtError.message,
              ...(caughtError.retryable !== undefined ? { retryable: caughtError.retryable } : {}),
            }
          : {
              message: caughtError instanceof Error ? caughtError.message : String(caughtError),
            };
      finalize("error", llmError);
      return;
    }

    if (ctxRef.explicitError !== undefined) {
      finalize(ctxRef.explicitStopReason ?? "error", ctxRef.explicitError);
      return;
    }

    const stopReason = ctxRef.explicitStopReason ?? (hasToolCalls ? "tool_calls" : "stop");
    finalize(stopReason);
  })();

  let readIndex = 0;

  return {
    result: () => resultPromise,
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
      return {
        next(): Promise<IteratorResult<LlmChunk>> {
          if (readIndex < emittedChunks.length) {
            const value = emittedChunks[readIndex++]!;
            return Promise.resolve({ value, done: false });
          }
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<LlmChunk>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}
