```ts
class ScriptedMockLlmProvider extends LlmProvider {
  readonly requests: MockRequestRecord[]; // 响应式请求记录列表
  readonly activeStreams: MockActiveStream[]; // 响应式活跃流列表
  readonly transcriptProblems: MockTranscriptProblem[];
  override readonly models: readonly LlmModelInfo[];
  constructor(handlerOrOptions?: MockHandler | ScriptedMockLlmOptions);
  use(middleware: MockMiddleware): void; // 在当前 EffectScope 中注册编程式洋葱中间件，随 Scope 自动卸载
  enqueue(...steps: readonly MockStep[]): this; // 追加一次性消费的剧本条目
  clearQueue(): this;
  clearRequests(): this;
  waitForRequest(
    countOrPredicate?: number | ((record: MockRequestRecord) => boolean),
    signal?: AbortSignal,
  ): Promise<MockRequestRecord>;
  override stream(request: LlmRequest): LlmStream;
  verify(options?: MockVerifyOptions): void; // 校验未消费队列、活跃流与对话配对不变量
}

class SyntheticMockLlmProvider extends ScriptedMockLlmProvider {
  constructor(options?: SyntheticMockLlmOptions); // 内置 echo / synthetic-text / synthetic-thinking / synthetic-tools / synthetic-chaos 预设与自定义 generators
}

class ReplayMockLlmProvider extends ScriptedMockLlmProvider {
  readonly recording: LlmRecording;
  constructor(options: ReplayMockLlmOptions); // 支持 match / sequential / session / 自定义匹配与 instant / recorded / paceMs 时序重放
  resetReplay(): this;
}

class RecordingLlmProvider extends LlmProvider {
  readonly inner: LlmProvider;
  readonly recording: LlmRecording;
  override readonly models: readonly LlmModelInfo[];
  constructor(inner: RecordingTarget, options?: RecordingLlmProviderOptions); // 支持直接传入 LlmProvider 实例，或传入 ServiceConstructor / Descriptor 在当前 Scope 内实例化
  override stream(request: LlmRequest): LlmStream;
}

class LlmRecording {
  readonly version: 1;
  readonly entries: RecordedEntry[]; // 响应式录制条目数组
  constructor(entries?: readonly RecordedEntry[]);
  static deserialize(raw: string): LlmRecording;
  static snapshot(request: LlmRequest): RecordedRequestSnapshot;
  toJSON(): { readonly version: 1; readonly entries: readonly RecordedEntry[] };
  serialize(): string;
}

class MockGate {
  readonly isWaiting: boolean;
  readonly waitCount: number;
  readonly arrived: Promise<void>;
  wait(signal?: AbortSignal): Promise<void>;
  release(): void;
  reject(error?: unknown): void;
}

interface MockContext {
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
```
