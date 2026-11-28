```ts
interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly folders: readonly string[]; // 至少 1 个绝对路径，folders[0] 为主根
  readonly instructions: string;
}

class WorkspaceCatalog {
  readonly host: SyncedArrayHost<Workspace>; // 有序 Workspace 列表，变更即落盘（SQLite workspaces 表）
  readonly items: readonly Workspace[];
  resolve(id: string | undefined): Workspace | undefined; // 找不到时回退至首个
}

// @harness/workspace-catalog/types：Workspace / WorkspaceSchema 的无运行时入口
```
