```ts
const SupplementaryField: FieldKey<MessageMeta, boolean>; // 标记补充性消息（仅含补充性消息时不触发循环发送）

class AgentLoop {
  readonly isRunning: boolean;
  readonly hooks: AgentLoopHooks;
  options: AgentLoopOptions;
  constructor(options?: AgentLoopOptions);
  shouldSend(): boolean; // 判断当前是否应发起下一轮模型请求
  run(): Promise<LoopStopReason>;
  abort(): void;
}

interface HandleOutputInput {
  readonly response: LlmResponse;
  readonly signal: AbortSignal;
}

interface AgentLoopHooks {
  readonly shouldSend: HookSlot<void, boolean>; // 判断当前是否应发起请求（如存在可发送输入且 toolCall 均已补全）
  readonly transformContext: HookSlot<ContextTransformInput, Promise<LlmInputPayload>>; // 将 Context 转换为 LLM API 输入
  readonly streamChunk: HookSlot<LlmStreamChunk, void>; // 观测主循环单步模型流式输出块
  readonly handleOutput: HookSlot<HandleOutputInput, Promise<void>>; // 消费模型输出（无返回值，如执行工具并追加到 pending）
  readonly handleError: HookSlot<unknown, Promise<void>>; // 错误处理洋葱圈（默认 terminal 重新抛出错误）
}
```
