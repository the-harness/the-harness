```ts
class UiChatManagerService {
  readonly mode: Ref<string>; // 当前对话模式（CrossTabSync）
  readonly model: WritableComputedRef<string>; // 当前模型 ID（CrossTabSync，默认回退至模型列表首项）
  readonly models: ComputedRef<readonly ChatModel[]>;
  readonly selectedModel: ComputedRef<ChatModel | undefined>;
  refreshModels(): Promise<void>; // 重新读取动态注册的模型
  get(sessionId: string): UiChatService; // 获取或创建指定会话的 UiChatService 实例
  composerHistory(sessionId: string): UiComposerHistoryService; // 获取指定会话输入框的历史 prompt 浏览状态
  link(scope: Scope, sessionId: string): UiChatService; // 将指定会话的 UiChatService 链接到目标 DI scope
  isRunning(sessionId?: string): boolean; // 不传参数时表示任意会话是否正在生成
  dispose(sessionId: string): void; // 中止并销毁指定会话的 UiChatService 实例
}
```
