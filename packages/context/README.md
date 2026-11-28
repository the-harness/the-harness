```ts
class BatchMeta extends ExtensibleFields {}

interface ContextBatch {
  readonly index: number;
  readonly messages: readonly Message[];
  readonly meta: BatchMeta; // 对元数据的修改仅对当前 context 生效
}

interface ContextCursor {
  readonly batchIndex: number;
  readonly messageCount?: number;
}

class Context {
  readonly id: string;
  readonly batchCount: number;
  readonly pending: Message[]; // 内存中的当前响应式 pending messages（shallowReactive 数组）
  readonly hooks: ContextHooks;
  constructor(options?: ContextOptions);
  batch(): ContextBatch; // 取走 pending 并交给 hooks.batch，由内层提交新 batch
  unbatch(): void; // 撤回最近一个 batch，将其中的消息放回 pending 头部
  readBackward(): AsyncIterable<ContextBatch>; // 从后往前异步读取已打包的 batches
  fork(options?: ContextForkOptions): Promise<ContextOptions>; // 从当前位置或指定游标创建独立的 context，返回其构造配置
}

interface ContextHooks {
  readonly batch: HookSlot<readonly Message[], ContextBatch>; // 输入是取走的 pending；hook 用 next(messages) 决定写入哪些消息，terminal 提交批次
}
```
