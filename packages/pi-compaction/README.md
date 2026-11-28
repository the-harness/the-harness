```ts
class CompactionSummaryMessage extends UserMessage {
  readonly from: number;
  readonly to: number;
  readonly summary?: string;
  readonly usage?: LlmUsage;
}

interface CompactionSlice {
  readonly from: number;
  readonly to: number; // 已压缩的最大 batch 索引
  readonly systemMessages: readonly SystemMessage[]; // 已压缩范围内保留的 system 消息
  readonly messages: readonly Message[]; // 压缩产出的消息列表（默认含 summary，可由 hooks.compact 追加其他消息）
}

const CompactionSliceField: FieldKey<BatchMeta, CompactionSlice>; // 挂载在 ContextBatch.meta 上的压缩切片字段

interface CompactionOptions {
  readonly signal?: AbortSignal;
  readonly customInstructions?: string;
  readonly reason?: "manual" | "threshold" | "overflow";
}

interface CompactionInput extends CompactionOptions {
  readonly messages: readonly Message[]; // 待压缩的消息序列（含上一次 slice.messages 与本次新增 batch 消息）
  readonly throughIndex: number;
}

interface CompactionHooks { // 可扩展
  readonly run: HookSlot<CompactionInput, Promise<CompactionSlice | undefined>>; // 包裹已确定切点的摘要生成与切片保存
  readonly compact: HookSlot<CompactionInput, Promise<readonly Message[]>>; // 压缩消息流（外层可提取自定义消息并在结果后追加）
}

class PiCompactionService {
  readonly hooks: CompactionHooks;
  keepRecentTokens: number;
  autoEnabled: boolean;
  maxActiveTokens?: number; // 调用方可覆盖自动压缩的活动窗口阈值
  backgroundTokens?: number; // 调用方可覆盖后台预压缩的余量，设为 0 时关闭预压缩
  latestSlice(upToIndex?: number): Promise<CompactionSlice | undefined>;
  estimateActiveSize(upToIndex?: number): Promise<number>;
  compact(throughIndex?: number, options?: CompactionOptions): Promise<CompactionSlice | undefined>;
  formatCompactionSummary(summary: string): string; // 将压缩摘要包装为 pi 兼容的 <summary> 模板
  formatBranchSummary(summary: string): string; // 将分支摘要包装为 pi 兼容的 <summary> 模板
}

useCompaction(options?: UseCompactionOptions): void // 在当前 EffectScope 中挂载 AgentLoop.hooks.transformContext 与 handleError 的自动压缩钩子

interface UseCompactionOptions {
  readonly maxTokens?: number; // 主动压缩阈值（活动窗口 token 数）；缺省时只在 context 溢出报错后压缩
  readonly keepRecentTokens?: number; // 压缩后保留的最近 token 数，默认 20000
  readonly backgroundTokens?: number; // 距 maxTokens 该余量时后台预压缩，默认 32768
  readonly isContextOverflowError?: (errorMessage: string) => boolean; // 判定 context 溢出错误
}
```
