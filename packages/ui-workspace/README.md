```ts
// Workspace / WorkspaceSchema 由 @harness/workspace-catalog/types 重新导出

interface WorkspaceFile {
  readonly path: string;
  readonly language: string;
  readonly status: string;
  readonly added: number;
  readonly removed: number;
  readonly content: string;
}

const WorkspaceStateSyncContract: StateSyncContract<{
  readonly items: StateSyncArrayEndpoint<z.ZodType<Workspace>>;
}>

class WorkspaceRootService {
  readonly root: string;
  isLoadingDir(relativePath?: string): boolean;
  getDirResult(relativePath?: string): ReadDirResult | undefined;
  loadDir(relativePath?: string, force?: boolean): Promise<ReadDirResult>;
  searchFiles(query: string, signal?: AbortSignal): Promise<{ paths: string[]; truncated: boolean }>; // Fuzzy filename/path search, up to 200 results per root; follows explorer exclusions.
  readFile(relativePath: string): Promise<ReadFileResult>;
  writeFile(relativePath: string, content: string, expectedMtimeMs?: number): Promise<{ mtimeMs: number; size: number }>;
  createFile(relativePath: string, content?: string): Promise<void>;
  createDir(relativePath: string): Promise<void>;
  renamePath(oldRelativePath: string, newRelativePath: string): Promise<void>; // Resolves after the filesystem rename and refreshes directories asynchronously.
  deletePath(relativePath: string): Promise<void>;
  onFileChange(listener: FileChangeListener): () => void;
}

interface WorkspaceFolderMenuContext {
  readonly workspaceId: string;
  readonly folder?: string;
  readonly edit: () => void;
  readonly remove: () => void;
  readonly browse: () => Promise<void>;
  readonly add: () => void;
}

class UiWorkspaceService {
  readonly folderMenu: Menu<WorkspaceFolderMenuContext, "folder" | "workspace">; // 工作区文件夹列表菜单
  readonly fileMenu: Menu<FileMenuContext, "open" | "create" | "clipboard" | "edit" | "workspace" | "view">; // 文件树菜单；各组定义默认项，context 提供视图操作
  readonly files: readonly WorkspaceFile[];
  readonly selectedFile: Ref<WorkspaceFile>; // 当前预览选中的文件（瞬态）
  readonly activeRoots: ComputedRef<string[]>; // 当前激活 Session 的有序工作目录列表
  readonly activeWorkspaceId: Ref<string>; // 当前激活的 Workspace ID（LocalSync）
  readonly workspaces: ComputedRef<readonly Workspace[]>; // Workspace 列表（StateSync 实时同步与落盘）
  readonly currentWorkspace: ComputedRef<Workspace | undefined>;
  getRoot(root: string): WorkspaceRootService; // 获取或创建对应 root 的 DI Scope 服务实例
  getFileTreeState(contextId: string, roots: readonly string[]): FileTreeState; // 按工作区保存文件树的展开和选中状态
  addRoot(root: string): void;
  removeRoot(root: string): void;
  reorderRoots(roots: string[]): void;
  onFileChange(listener: FileChangeListener): () => void;
  getWorkspace(id: string): Workspace | undefined;
  createWorkspace(options: { readonly name?: string; readonly folders: readonly string[]; readonly instructions?: string }): Workspace; // folders 不能为空
  openFolder(folder: string): Workspace; // 以该绝对路径创建或复用 workspace 并激活
  duplicateWorkspace(sourceId: string): Workspace | undefined;
  renameWorkspace(id: string, name: string): void;
  addFolder(id: string, folder: string): boolean;
  updateFolder(id: string, index: number, folder: string): boolean;
  removeFolder(id: string, folder: string): void; // 保留最后一个 folder
  updateInstructions(id: string, instructions: string): void;
  removeWorkspace(id: string): void;
  selectFile(file: WorkspaceFile): void;
}

interface FileMenuTarget {
  readonly root: string;
  readonly relativePath: string;
  readonly isDirectory: boolean;
}
interface FileMenuContext {
  readonly target?: FileMenuTarget;
  readonly treeContextId: string;
  readonly rootCount: number;
  readonly canCollapse: boolean;
  readonly folderActionLabel: string;
  readonly isMac: boolean;
  readonly open: () => Promise<void>;
  readonly create: (kind: "new-file" | "new-folder") => void;
  readonly copyPath: (relative: boolean) => Promise<void>;
  readonly rename: () => Promise<void>;
  readonly delete: () => Promise<void>;
  readonly pickRoot: () => Promise<void>;
  readonly removeRoot: () => void;
  readonly refresh: () => void;
  readonly collapseAll: () => void;
}

function useWorkspaceHandlers(): void; // Node 侧：注册 Workspace Rpc / Stream / StateSync 契约的服务端实现（列表宿主为 WorkspaceCatalog）
```
