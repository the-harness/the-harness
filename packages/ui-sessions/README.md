```ts
class SessionMeta extends ExtensibleFields {}

// SessionSummary / SessionSummarySchema 由 @harness/session-catalog/types 重新导出

interface SessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string; // 未命名时为 "New conversation"
  readonly createdAt: number;
  readonly modelId?: string;
  readonly presetId?: string;
  readonly meta: SessionMeta;
}

const SessionsStateSyncContract: StateSyncContract<{
  readonly items: StateSyncArrayEndpoint<z.ZodType<SessionSummary>, true>; // 只读，变更走 SessionsRpcContract
}>

const SessionsRpcContract: RpcContract<{
  create: { id: string; workspaceId: string } => void;
  rename: { id: string; title: string } => void;
  setMeta: { id: string; meta?: Record<string, unknown> } => void;
  remove: { id: string } => void;
}>

interface UiSessionsHooks {
  readonly remove: HookSlot<string, void>; // 删除会话时触发，可在 terminal 前中止关联运行
}

class UiSessionsService {
  readonly menu: Menu<SessionMenuContext, "actions" | "destructive">; // 会话树菜单；各组定义默认项，扩展贡献由注册 scope 管理
  readonly activeId: Ref<string>; // 当前窗口激活会话 ID（LocalSync）
  readonly sessions: ComputedRef<readonly SessionView[]>;
  readonly current: ComputedRef<SessionView | undefined>; // 新建会话回到目录前为 undefined
  readonly hooks: UiSessionsHooks;
  newSession(workspaceId?: string): string; // 请求后端创建并激活，返回会话 ID
  renameSession(id: string, title: string): void;
  commitMeta(id: string): void; // 将指定会话的 SessionMeta 扩展字段序列化并写入目录
  removeSession(id: string): void; // 删除会话并清理所属 session 存储桶
  removeWorkspaceSessions(workspaceId: string): void; // 删除指定 Workspace 下的所有会话
}

interface SessionMenuContext {
  readonly node?: TreeNode;
  readonly workspaceId?: string;
  readonly canCollapse: boolean;
  readonly createConversation: () => void;
  readonly open: () => void;
  readonly runAction: (action: TreeAction) => void;
  readonly openFolder?: () => void;
  readonly collapseAll: () => void;
}

function useSessionsHandlers(): void; // Node 侧：以 SessionCatalog 注册 SessionsStateSyncContract / SessionsRpcContract 服务端实现；每个 session Scope 以 ServerTransport.childScope(sessionId) 提供自己的 ServerTransport 与 Rpc / Stream / StateSync 服务端，作用域为该会话的调用路由至其中注册的 handlers
```
