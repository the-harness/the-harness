```ts
function useChatSessions(): void; // 经 SessionManager 在每个 session Scope 中提供 CwdService、ModelSelectionService、AgentManager、ChatRunService、ChatSession

// session Scope 服务：一个会话的聊天运行时（构造参数为 sessionId）；模型与 preset 存于 SessionCatalog 的会话条目
class ChatSession {
  readonly pending: SyncedArrayHost<UserMessage>; // steer 输入
  readonly queue: SyncedArrayHost<UserMessage>; // 后续 turn 排队
  readonly status: SyncedValueHost<ChatRunState>;
  readonly context: Context; // agent 的 Context；首次 run 前为读取已落盘 transcript 的临时 Context
  loadMessages(options?: { readonly before?: number; readonly limit?: number }): Promise<ChatMessagesPage>; // 倒序分页读取历史消息（不含 supplementary 的 agent 内部消息）
  configure(options: ChatRunOptions): void; // 写入会话的模型与 preset；会话开始后（运行中或已有 batch）忽略 preset
  start(options?: ChatRunOptions): void; // 先 configure(options)；空闲时按 pending → queue 首个 turn 启动 run，结束后自动续跑，未产出即中止或失败时退回 pending；未命名会话以首条输入命名
  stream(options?: ChatRunOptions): AsyncIterable<ChatStreamEvent>; // start 并订阅
  attach(signal?: AbortSignal): AsyncIterable<ChatStreamEvent>; // 从头重放并订阅活跃 run（无则立即结束，signal 中止时结束）
  abort(): boolean;
  acknowledgeStatus(): void;
}

// @harness/chat-session/types：无运行时入口
interface ChatRunOptions {
  readonly modelId?: string;
  readonly presetId?: string;
}

const ChatDurationField: FieldKey<MessageMeta, number>; // 助手步骤耗时（毫秒，含工具执行），随消息保存
const ChatTimestampField: FieldKey<MessageMeta, number>; // 用户消息提交时间（Unix 毫秒），随消息保存
const TurnGroupField: FieldKey<MessageMeta, string>; // 同一 turn 的排队消息分组

interface ChatRunState {
  readonly runId: string | null; // 活跃 run，订阅方据此重放同一 run
  readonly before: number; // run 开始前的 batch 数，即 run 之前历史的分页游标
  readonly notice: string;
}

type ChatStreamEvent = // run 以核心类型重放：已提交的消息（被消费的输入、每步最终的助手消息、工具结果）与当前步的增量
  | { readonly type: "message"; readonly message: SerializedVariant }
  | { readonly type: "chunk"; readonly chunk: Exclude<LlmChunk, { readonly type: "finish" }> }
  | { readonly type: "tool_output"; readonly id: string; readonly delta: string }
  | { readonly type: "error"; readonly message: string };

interface ChatMessagesPage {
  readonly messages: readonly SerializedVariant[];
  readonly nextBefore: number | null;
  readonly hasMore: boolean;
}
```
