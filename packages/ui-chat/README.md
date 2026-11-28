```ts
interface ChatMenuContext {
  readonly message?: SessionMessage;
  readonly input?: UserMessage;
  readonly selection: string;
  readonly link?: string;
  readonly canEdit: boolean;
  readonly canReuse: boolean;
  readonly edit: () => void;
  readonly remove: () => Promise<void>;
  readonly openLink: () => void;
  readonly reuse: () => void;
  readonly selectAll: () => void;
}

class UiChatService {
  readonly menu: Menu<ChatMenuContext, "queue" | "clipboard" | "links" | "prompt" | "selection">; // Message menus scoped to this conversation.
}

// 一行 transcript：用户输入、一个助手 turn（仅调用工具的步骤并入其后一步），或其他消息类型（保留为 source）
interface SessionMessage {
  readonly id: string; // 消息自身 id
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly source?: Message;
  readonly images?: readonly ImageBlock[];
  readonly activities?: readonly ActivityItem[];
  readonly changes?: readonly TurnFileChange[];
  readonly timestamp?: number;
  readonly durationMs?: number;
  readonly streaming?: boolean;
}

type SyncListTarget = "pending" | "queue";

interface ChatPreset {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: AgentPresetIcon; // preset 自身提供的图片或单色遮罩（@harness/agent-preset）
}

// 可拓展接口：注册聊天提交 hook
interface UiChatHooks {
  readonly submitMessage: HookSlot<void>; // 发送、排队或 steer 后触发
}

class UiChatService {
  readonly hooks: UiChatHooks;
  readonly sessionId: string;
  readonly mode: Ref<string>; // 当前对话模式（CrossTabSync）
  readonly model: WritableComputedRef<string>; // 当前会话模型 ID（会话条目的 modelId；未设置时回退至本地默认偏好，再回退至模型列表首项）
  readonly models: ComputedRef<readonly ChatModel[]>;
  readonly selectedModel: ComputedRef<ChatModel | undefined>;
  readonly preset: WritableComputedRef<string>; // 当前会话 Agent Preset ID（会话条目的 presetId；空白会话可切换，首轮开始后由后端锁定）
  readonly presets: ComputedRef<readonly ChatPreset[]>;
  readonly selectedPreset: ComputedRef<ChatPreset | undefined>;
  readonly isPresetLocked: ComputedRef<boolean>; // 首轮已开始或运行中时为 true
  readonly messages: ComputedRef<SessionMessage[]>; // 后端已提交历史与活跃 run 的重放消息，经同一转换得到；timestamp 为可选的提交时间（Unix 毫秒），durationMs 为可选的步骤耗时（毫秒）
  readonly pendingInputs: ComputedRef<UserMessage[]>; // 当前会话顶部 Steer 队列（SyncedArrayClient）
  readonly queuedInputs: ComputedRef<UserMessage[]>; // 当前会话后续 Turn 排队队列（SyncedArrayClient）
  readonly draft: WritableComputedRef<string>; // 当前会话草稿
  readonly draftImages: WritableComputedRef<readonly ImageBlock[]>; // 当前会话草稿中的已上传附件引用
  readonly notice: ShallowRef<string>; // 服务端 run 的失败或退回队列提示（ChatRunState.notice）
  refreshChoices(): Promise<void>; // 重新读取动态注册的模型与 preset 元数据
  isRunning(): boolean; // 服务端是否有活跃 run（与发起方无关）
  hasMoreMessages(): boolean;
  loadOlder(): Promise<number>; // 从后端按需加载更早一页消息并返回新增条数
  send(content?: readonly ContentBlock[]): Promise<void>;
  steer(content?: readonly ContentBlock[]): Promise<void>;
  steerQueued(index?: number): Promise<void>;
  abort(): void;
  acknowledgeStatus(): void; // 标记当前会话状态已读（清除 Completed / Failed 这类终态）
}

class MarkdownHighlighterService {
  readonly ready: Ref<boolean>; // shiki 高亮器加载完成
  readonly grammarVersion: Ref<number>; // 按需加载的语法每加载一种递增
  load(): Promise<void>;
}
```

```ts
// @harness/ui-chat/node：ui-chat 契约的服务端实现，依赖 @harness/chat-session
function useChatHandlers(): void; // 注册 ui-chat 契约的服务端实现：模型与 preset 列表在根 Scope，其余在每个 session Scope 中直接使用 ChatSession（需先调用 useChatSessions 与 useSessionsHandlers）
```
