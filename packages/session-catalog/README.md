```ts
interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string; // 未命名时缺省（ChatSession 以首条输入命名）
  readonly createdAt: number;
  readonly modelId?: string; // 会话所用模型
  readonly presetId?: string; // 会话所用 Agent Preset（是否锁定由 ChatSession 判断）
  readonly meta?: Record<string, unknown>; // 扩展字段（如 UI 的 SessionMeta）
}

class SessionCatalog {
  readonly host: SyncedArrayHost<SessionSummary>; // 按创建时间倒序，供客户端只读同步
  readonly items: readonly SessionSummary[];
  get(id: string): SessionSummary | undefined;
  create(input: { readonly id?: string; readonly workspaceId: string }): SessionSummary; // 已存在则原样返回
  rename(id: string, title: string): void; // 空白标题忽略
  configure(id: string, config: { readonly modelId?: string; readonly presetId?: string }): void; // 仅覆盖已给出的字段
  setMeta(id: string, meta: Record<string, unknown> | undefined): void;
  remove(id: string): void;
  onCreate(listener: (id: string) => void): () => void;
  onRemove(listener: (id: string) => void): () => void;
}

// @harness/session-catalog/types：SessionSummary / SessionSummarySchema 的无运行时入口
```
