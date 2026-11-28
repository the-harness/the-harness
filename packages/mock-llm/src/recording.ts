import { Descriptor, inject, InstantiationService, type ServiceConstructor } from "@harness/di";
import {
  LlmProvider,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  type LlmChunk,
  type LlmError,
  type LlmModelInfo,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmStream,
  type LlmUsage,
} from "@harness/llm";
import { ExtensibleVariants, type SerializedVariant } from "@harness/variants";
import { shallowReactive, toValue, type MaybeRefOrGetter } from "reactivity";
import { ScriptedMockLlmProvider, type MockVerifyOptions } from "./scripted.ts";
import type {
  MockContext,
  MockHandlerReturn,
  MockModelConfig,
  ScriptedMockLlmOptions,
} from "./types.ts";
import { extractRequestFacts, MockLlmError } from "./utils.ts";

export interface RecordedChunk {
  readonly offsetMs: number;
  readonly chunk: Exclude<LlmChunk, { readonly type: "finish" }>;
}

export interface RecordedRequestSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly sessionId?: string;
  readonly systemPrompt?: string;
  readonly toolNames: readonly string[];
  readonly lastUserText: string;
  readonly toolResultCount: number;
  readonly messageCount: number;
  readonly messages: readonly SerializedVariant[];
}

export interface RecordedEntry {
  readonly id: string;
  readonly recordedAt: string;
  readonly request: RecordedRequestSnapshot;
  readonly chunks: readonly RecordedChunk[];
  readonly stopReason: LlmStopReason;
  readonly usage?: LlmUsage;
  readonly error?: LlmError;
  readonly replayState?: unknown;
}

export class LlmRecording {
  readonly version = 1 as const;
  readonly entries: RecordedEntry[];

  constructor(entries: readonly RecordedEntry[] = []) {
    this.entries = shallowReactive([...entries]);
  }

  static deserialize(raw: string): LlmRecording {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      throw new Error("Invalid recording JSON: expected { version: 1, entries: [...] }");
    }
    return new LlmRecording((parsed as { entries: RecordedEntry[] }).entries);
  }

  static snapshot(request: LlmRequest): RecordedRequestSnapshot {
    const facts = extractRequestFacts(request.messages);
    return {
      provider: request.provider,
      model: request.model,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      toolNames: (request.tools ?? []).map((t) => t.name),
      lastUserText: facts.lastUserText,
      toolResultCount: facts.toolResults.length,
      messageCount: request.messages.length,
      messages: request.messages.map((msg) => ExtensibleVariants.serialize(msg)),
    };
  }

  toJSON(): { readonly version: 1; readonly entries: readonly RecordedEntry[] } {
    return {
      version: 1,
      entries: [...this.entries],
    };
  }

  serialize(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}

export interface RecordingLlmProviderOptions {
  readonly recording?: LlmRecording;
  readonly redact?: (snapshot: RecordedRequestSnapshot) => RecordedRequestSnapshot;
  readonly onRecord?: (entry: RecordedEntry, recording: LlmRecording) => void;
}

export type ReplayTiming = "instant" | "recorded" | { readonly paceMs: number };

export type ReplayMatcher = (
  ctx: MockContext,
  remaining: readonly RecordedEntry[],
) => RecordedEntry | undefined;

export type ReplayStrategy = "match" | "sequential" | "session" | ReplayMatcher;

export interface ReplayMockLlmOptions extends Omit<ScriptedMockLlmOptions, "handler"> {
  readonly recording: MaybeRefOrGetter<LlmRecording> | readonly RecordedEntry[] | string;
  readonly strategy?: ReplayStrategy;
  readonly timing?: MaybeRefOrGetter<ReplayTiming>;
  readonly consumeOnce?: boolean;
  readonly strict?: boolean;
  readonly transformChunk?: (
    chunk: Exclude<LlmChunk, { readonly type: "finish" }>,
    ctx: MockContext,
    entry: RecordedEntry,
  ) => Exclude<LlmChunk, { readonly type: "finish" }>;
}

function chunksFromResponse(response: LlmResponse): RecordedChunk[] {
  const out: RecordedChunk[] = [];
  for (const block of response.message.content) {
    if (block instanceof ThinkingBlock && block.thinking.length > 0) {
      out.push({ offsetMs: 0, chunk: { type: "thinking_delta", delta: block.thinking } });
    } else if (block instanceof TextBlock && block.text.length > 0) {
      out.push({ offsetMs: 0, chunk: { type: "text_delta", delta: block.text } });
    } else if (block instanceof ToolCallBlock) {
      out.push({
        offsetMs: 0,
        chunk: { type: "tool_call_start", id: block.id, name: block.name },
      });
      if (block.arguments.length > 0) {
        out.push({
          offsetMs: 0,
          chunk: { type: "tool_call_delta", id: block.id, delta: block.arguments },
        });
      }
      out.push({
        offsetMs: 0,
        chunk: {
          type: "tool_call_end",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        },
      });
    }
  }
  return out;
}

export type RecordingTarget =
  | LlmProvider
  | ServiceConstructor<LlmProvider>
  | Descriptor<LlmProvider>;

export class RecordingLlmProvider extends LlmProvider {
  readonly inner: LlmProvider;
  readonly recording: LlmRecording;
  protected readonly options: RecordingLlmProviderOptions;

  constructor(inner: RecordingTarget, options: RecordingLlmProviderOptions = {}) {
    super();
    if (inner instanceof Descriptor) {
      this.inner = inject(InstantiationService).createInstance(inner);
    } else if (typeof inner === "function") {
      this.inner = inject(InstantiationService).createInstance(inner);
    } else {
      this.inner = inner;
    }
    this.options = options;
    this.recording = options.recording ?? new LlmRecording();
  }

  override get models(): readonly LlmModelInfo[] {
    return this.inner.models;
  }

  override stream(request: LlmRequest): LlmStream {
    const startedAt = performance.now();
    const rawSnapshot = LlmRecording.snapshot(request);
    const snapshot =
      this.options.redact !== undefined ? this.options.redact(rawSnapshot) : rawSnapshot;
    const innerStream = this.inner.stream(request);
    const chunks: RecordedChunk[] = [];
    let committed = false;

    const commit = (stopReason: LlmStopReason, response?: LlmResponse, error?: LlmError) => {
      if (committed) return;
      committed = true;
      const recordedChunks =
        chunks.length === 0 && response !== undefined ? chunksFromResponse(response) : chunks;
      const entry: RecordedEntry = {
        id: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        request: snapshot,
        chunks: recordedChunks,
        stopReason: response?.stopReason ?? stopReason,
        ...(response?.usage !== undefined ? { usage: response.usage } : {}),
        ...(response?.error !== undefined
          ? { error: response.error }
          : error !== undefined
            ? { error }
            : {}),
        ...(response?.message.replayState !== undefined
          ? { replayState: response.message.replayState }
          : {}),
      };
      this.recording.entries.push(entry);
      this.options.onRecord?.(entry, this.recording);
    };

    const result = async (): Promise<LlmResponse> => {
      try {
        const res = await innerStream.result();
        commit(res.stopReason, res);
        return res;
      } catch (err) {
        const isAborted = Boolean(request.signal?.aborted);
        commit(isAborted ? "aborted" : "error", undefined, {
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    return {
      result,
      [Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
        const innerIter = innerStream[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<LlmChunk>> {
            try {
              const step = await innerIter.next();
              if (step.done) {
                if (!committed) {
                  commit(request.signal?.aborted ? "aborted" : "stop");
                }
                return step;
              }
              const chunk = step.value;
              if (chunk.type === "finish") {
                commit(chunk.response.stopReason, chunk.response);
              } else {
                const offsetMs = Math.max(0, Math.round(performance.now() - startedAt));
                chunks.push({ offsetMs, chunk });
              }
              return step;
            } catch (err) {
              const isAborted = Boolean(request.signal?.aborted);
              commit(isAborted ? "aborted" : "error", undefined, {
                message: err instanceof Error ? err.message : String(err),
              });
              throw err;
            }
          },
          async return(value?: unknown): Promise<IteratorResult<LlmChunk>> {
            try {
              if (innerIter.return !== undefined) {
                return await innerIter.return(value);
              }
              return { value: undefined, done: true };
            } finally {
              commit("aborted");
            }
          },
        };
      },
    };
  }
}

export class ReplayMockLlmProvider extends ScriptedMockLlmProvider {
  protected readonly replayOptions: ReplayMockLlmOptions;
  protected readonly staticRecording: LlmRecording | undefined;
  protected readonly consumedIds = new Set<string>();
  protected readonly sessionGroups = new Map<string, string>();

  constructor(options: ReplayMockLlmOptions) {
    super({
      ...options,
      providerId: options.providerId ?? "mock-replay",
    });
    this.replayOptions = options;
    if (typeof options.recording === "string") {
      this.staticRecording = LlmRecording.deserialize(options.recording);
    } else if (Array.isArray(options.recording)) {
      this.staticRecording = new LlmRecording(options.recording);
    }
  }

  get recording(): LlmRecording {
    return this.resolveRecording();
  }

  protected resolveRecording(): LlmRecording {
    if (this.staticRecording !== undefined) {
      return this.staticRecording;
    }
    return toValue(this.replayOptions.recording as MaybeRefOrGetter<LlmRecording>);
  }

  protected override defaultModels(): readonly (MockModelConfig | LlmModelInfo)[] {
    const recording = this.resolveRecording();
    const seen = new Set<string>();
    const models: MockModelConfig[] = [];
    for (const entry of recording.entries) {
      if (!seen.has(entry.request.model)) {
        seen.add(entry.request.model);
        models.push({ id: entry.request.model, name: entry.request.model });
      }
    }
    return models.length > 0 ? models : [{ id: "mock-replay", name: "Mock Replay" }];
  }

  resetReplay(): this {
    this.consumedIds.clear();
    this.sessionGroups.clear();
    return this;
  }

  protected getRemainingEntries(recording: LlmRecording): readonly RecordedEntry[] {
    if (this.replayOptions.consumeOnce === false) {
      return recording.entries;
    }
    return recording.entries.filter((entry) => !this.consumedIds.has(entry.id));
  }

  protected pickEntry(
    ctx: MockContext,
    remaining: readonly RecordedEntry[],
  ): RecordedEntry | undefined {
    const strategy = this.replayOptions.strategy ?? "match";
    if (typeof strategy === "function") {
      return strategy(ctx, remaining);
    }
    if (strategy === "sequential") {
      return remaining[0];
    }
    if (strategy === "session") {
      const liveSession = ctx.request.sessionId ?? "";
      let recordedSession = this.sessionGroups.get(liveSession);
      if (recordedSession === undefined) {
        const boundSessions = new Set(this.sessionGroups.values());
        const nextEntry = remaining.find(
          (entry) => !boundSessions.has(entry.request.sessionId ?? ""),
        );
        if (nextEntry === undefined) {
          return undefined;
        }
        recordedSession = nextEntry.request.sessionId ?? "";
        this.sessionGroups.set(liveSession, recordedSession);
      }
      return remaining.find((entry) => (entry.request.sessionId ?? "") === recordedSession);
    }

    const byContent = remaining.filter(
      (entry) =>
        entry.request.lastUserText === ctx.lastUserText &&
        entry.request.toolResultCount === ctx.toolResults.length,
    );
    if (byContent.length === 0) {
      return undefined;
    }
    return byContent.find((entry) => entry.request.model === ctx.request.model) ?? byContent[0];
  }

  protected override resolveDefault(ctx: MockContext): MockHandlerReturn {
    const recording = this.resolveRecording();
    const remaining = this.getRemainingEntries(recording);
    const entry = this.pickEntry(ctx, remaining);
    if (entry === undefined) {
      throw new MockLlmError(
        `no recorded entry matched request #${ctx.callIndex} (model='${ctx.request.model}', toolResults=${ctx.toolResults.length}, remaining=${remaining.length})`,
      );
    }

    if (this.replayOptions.consumeOnce !== false) {
      this.consumedIds.add(entry.id);
    }

    const timing = toValue(this.replayOptions.timing ?? "instant");
    let prevOffsetMs = 0;

    for (const item of entry.chunks) {
      let delayMs = 0;
      if (timing === "recorded") {
        delayMs = Math.max(0, item.offsetMs - prevOffsetMs);
        prevOffsetMs = item.offsetMs;
      } else if (typeof timing === "object") {
        delayMs = timing.paceMs;
      }
      const chunk =
        this.replayOptions.transformChunk !== undefined
          ? this.replayOptions.transformChunk(item.chunk, ctx, entry)
          : item.chunk;
      ctx.chunk(chunk, delayMs);
    }

    if (entry.usage !== undefined) {
      ctx.usage(entry.usage);
    }
    if (entry.replayState !== undefined) {
      ctx.replayState(entry.replayState);
    }
    if (entry.error !== undefined) {
      return {
        stopReason: entry.stopReason,
        error: entry.error,
      };
    }
    ctx.stopReason(entry.stopReason);
    return undefined;
  }

  protected override collectVerificationErrors(options: MockVerifyOptions): string[] {
    const failures = super.collectVerificationErrors(options);
    if (this.replayOptions.strict !== false && this.replayOptions.consumeOnce !== false) {
      const remaining = this.getRemainingEntries(this.resolveRecording());
      if (remaining.length > 0) {
        failures.push(`${remaining.length} recorded entry(ies) were never replayed`);
      }
    }
    return failures;
  }
}
