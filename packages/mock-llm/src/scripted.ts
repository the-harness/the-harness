import { CurrentScope, optionalInject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { LlmProvider, type LlmModelInfo, type LlmRequest, type LlmStream } from "@harness/llm";
import {
  computed,
  getCurrentScope,
  shallowReactive,
  toValue,
  watch,
  type ComputedRef,
} from "reactivity";
import {
  applyMockHandlerReturn,
  type MockContextImpl,
  runMockStream,
  type MockStreamPacing,
} from "./stream.ts";
import type {
  MockActiveStream,
  MockContext,
  MockHandler,
  MockHandlerReturn,
  MockMiddleware,
  MockModelConfig,
  MockRequestRecord,
  MockStep,
  MockTranscriptProblem,
  ScriptedMockLlmOptions,
} from "./types.ts";
import {
  findTranscriptProblems,
  MOCK_DEFAULT_CONTEXT_WINDOW,
  MOCK_DEFAULT_MAX_TOKENS,
  MockAbortError,
  MockLlmError,
  toLlmModelInfo,
} from "./utils.ts";

export interface MockVerifyOptions {
  readonly allowUnconsumedQueue?: boolean;
  readonly allowTranscriptProblems?: boolean;
  readonly allowActiveStreams?: boolean;
}

const DEFAULT_SCRIPTED_MODELS: readonly MockModelConfig[] = [{ id: "mock", name: "Mock" }];

export class ScriptedMockLlmProvider extends LlmProvider {
  readonly requests: MockRequestRecord[] = shallowReactive([]);
  readonly activeStreams: MockActiveStream[] = shallowReactive([]);
  readonly transcriptProblems: MockTranscriptProblem[] = shallowReactive([]);

  protected readonly options: ScriptedMockLlmOptions;
  protected readonly providerId: string;
  protected readonly scopeId = optionalInject(CurrentScope)?.id;
  protected readonly hooks = {
    request: new HookSlot<MockContextImpl, Promise<void>>(),
  };
  protected readonly _queue: MockStep[] = shallowReactive([]);
  protected readonly _defaultHandler: MockHandler | undefined;
  protected readonly sessionPrefixCache = new Map<string, readonly string[]>();
  protected readonly sessionCallCounts = new Map<string, number>();
  protected readonly pacing: MockStreamPacing;
  protected _nextCallIndex = 0;

  protected readonly resolvedModels: ComputedRef<readonly LlmModelInfo[]> = computed(() => {
    const raw =
      this.options.models !== undefined ? toValue(this.options.models) : this.defaultModels();
    return raw.map((item) =>
      toLlmModelInfo(
        this.providerId,
        item,
        this.options.defaultContextWindow ?? MOCK_DEFAULT_CONTEXT_WINDOW,
        this.options.defaultMaxTokens ?? MOCK_DEFAULT_MAX_TOKENS,
      ),
    );
  });

  constructor(handlerOrOptions?: MockHandler | ScriptedMockLlmOptions) {
    super();
    const options: ScriptedMockLlmOptions =
      typeof handlerOrOptions === "function"
        ? { handler: handlerOrOptions }
        : (handlerOrOptions ?? {});
    this.options = options;
    this._defaultHandler = options.handler;

    this.providerId = options.providerId ?? this.scopeId ?? "mock";
    this.pacing = {
      chunkSize: options.chunkSize ?? 0,
      chunkDelayMs: options.chunkDelayMs ?? 0,
      firstTokenDelayMs: options.firstTokenDelayMs ?? 0,
    };
  }

  protected defaultModels(): readonly (MockModelConfig | LlmModelInfo)[] {
    return DEFAULT_SCRIPTED_MODELS;
  }

  override get models(): readonly LlmModelInfo[] {
    return this.resolvedModels.value;
  }

  get pendingQueueCount(): number {
    return this._queue.length;
  }

  use(middleware: MockMiddleware): void {
    if (getCurrentScope() === undefined) {
      throw new Error("use() requires an active EffectScope");
    }
    this.hooks.request.use(async (ctx, next) => {
      await applyMockHandlerReturn(ctx, await middleware(ctx, next));
    });
  }

  enqueue(...steps: readonly MockStep[]): this {
    this._queue.push(...steps);
    return this;
  }

  clearQueue(): this {
    this._queue.length = 0;
    return this;
  }

  clearRequests(): this {
    this.requests.length = 0;
    this.transcriptProblems.length = 0;
    this.sessionPrefixCache.clear();
    this.sessionCallCounts.clear();
    this._nextCallIndex = 0;
    return this;
  }

  waitForRequest(
    countOrPredicate: number | ((record: MockRequestRecord) => boolean) = 1,
    signal?: AbortSignal,
  ): Promise<MockRequestRecord> {
    const findMatch = (): MockRequestRecord | undefined => {
      if (typeof countOrPredicate === "number") {
        return this.requests.length >= countOrPredicate
          ? this.requests[countOrPredicate - 1]
          : undefined;
      }
      return this.requests.find(countOrPredicate);
    };

    const immediate = findMatch();
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }
    if (signal?.aborted) {
      return Promise.reject(new MockAbortError());
    }

    return new Promise<MockRequestRecord>((resolve, reject) => {
      const cleanup = () => {
        stopWatch();
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new MockAbortError());
      };
      const stopWatch = watch(
        () => this.requests.length,
        () => {
          const hit = findMatch();
          if (hit !== undefined) {
            cleanup();
            resolve(hit);
          }
        },
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  override stream(request: LlmRequest): LlmStream {
    const callIndex = this._nextCallIndex++;
    const sessionKey = request.sessionId ?? "";
    const sessionCallIndex = this.sessionCallCounts.get(sessionKey) ?? 0;
    this.sessionCallCounts.set(sessionKey, sessionCallIndex + 1);

    for (const problem of findTranscriptProblems(request.messages)) {
      this.transcriptProblems.push({ callIndex, message: problem });
    }

    const startedAt = Date.now();
    const recordIndex = this.requests.length;
    const initialRecord: MockRequestRecord = {
      index: callIndex,
      sessionCallIndex,
      request,
      startedAt,
    };
    this.requests.push(initialRecord);

    const activeEntry: MockActiveStream = {
      index: callIndex,
      request,
      startedAt,
    };
    this.activeStreams.push(activeEntry);

    const runStep = async (step: MockStep, ctx: MockContext): Promise<MockHandlerReturn> => {
      if (typeof step === "function") {
        return step(ctx);
      }
      return step;
    };

    const runTerminal = async (ctx: MockContext): Promise<MockHandlerReturn> => {
      const queued = this._queue.shift();
      if (queued !== undefined) {
        return runStep(queued, ctx);
      }
      return this.resolveDefault(ctx);
    };

    return runMockStream({
      request,
      callIndex,
      sessionCallIndex,
      pacing: this.pacing,
      sessionPrefixCache: this.sessionPrefixCache,
      execute: (ctx) =>
        this.hooks.request.run(ctx, async (input) => {
          await applyMockHandlerReturn(input, await runTerminal(input));
        }),
      onFinish: (response) => {
        const activeIdx = this.activeStreams.indexOf(activeEntry);
        if (activeIdx >= 0) {
          this.activeStreams.splice(activeIdx, 1);
        }
        this.requests[recordIndex] = {
          ...initialRecord,
          finishedAt: Date.now(),
          response,
          ...(response.error !== undefined ? { error: response.error } : {}),
        };
      },
    });
  }

  protected resolveDefault(ctx: MockContext): MockHandlerReturn | Promise<MockHandlerReturn> {
    if (this._defaultHandler !== undefined) {
      return this._defaultHandler(ctx);
    }
    throw new MockLlmError(
      `no scripted mock response for request #${ctx.callIndex} (model '${ctx.request.model}')`,
    );
  }

  verify(options: MockVerifyOptions = {}): void {
    const failures = this.collectVerificationErrors(options);
    if (failures.length > 0) {
      throw new Error(`Mock verification failed:\n- ${failures.join("\n- ")}`);
    }
  }

  protected collectVerificationErrors(options: MockVerifyOptions): string[] {
    const failures: string[] = [];
    if (!options.allowUnconsumedQueue && this._queue.length > 0) {
      failures.push(`${this._queue.length} queued mock step(s) were never consumed`);
    }
    if (!options.allowActiveStreams && this.activeStreams.length > 0) {
      failures.push(`${this.activeStreams.length} mock stream(s) are still active`);
    }
    if (!options.allowTranscriptProblems && this.transcriptProblems.length > 0) {
      for (const issue of this.transcriptProblems) {
        failures.push(`request #${issue.callIndex}: ${issue.message}`);
      }
    }
    return failures;
  }
}
