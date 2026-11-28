import { createDescriptor, CurrentScope, inject, type Scope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { UiSessionsService } from "@harness/ui-sessions";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import {
  computed,
  onScopeDispose,
  reactive,
  ref,
  shallowRef,
  toRef,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { z } from "zod";
import { WorkspaceSchema, WorkspaceStateSyncContract } from "./contract.ts";
import { workspaceNodeId } from "./node-id.ts";
import {
  WorkspaceRpcContract,
  WorkspaceStreamContract,
  type ReadDirResult,
  type ReadFileResult,
  type WorkspaceEntry,
  type WorkspaceWatchEvent,
} from "./rpc.ts";
import { seedWorkspaceFiles, type Workspace, type WorkspaceFile } from "./seed.ts";
import { createWorkspaceFolderMenu, createFileMenu } from "./menus.ts";

export { WorkspaceSchema, WorkspaceStateSyncContract };
export {
  WorkspaceRpcContract,
  WorkspaceStreamContract,
  type ReadDirResult,
  type ReadFileResult,
  type Workspace,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceWatchEvent,
};

export type { FileMenuTarget, FileMenuContext, WorkspaceFolderMenuContext } from "./menus.ts";

export interface FileTreeState {
  expandedIds: string[];
  selectedIds: string[];
}

export type FileChangeListener = (event: WorkspaceWatchEvent) => void;

export { parseWorkspaceNodeId, workspaceNodeId } from "./node-id.ts";

export class WorkspaceRootService {
  readonly root: string;
  private readonly rpc = inject(RpcClientService).use(WorkspaceRpcContract);
  private readonly stream = inject(StreamClientService).use(WorkspaceStreamContract);

  private readonly dirCache = reactive(new Map<string, ReadDirResult>());
  private readonly loadingDirs = reactive(new Set<string>());
  private readonly changeListeners = new Set<FileChangeListener>();
  private readonly watchAbort = new AbortController();

  constructor(root: string) {
    this.root = root;
    this.startWatcher();
    onScopeDispose(() => {
      this.watchAbort.abort();
      this.changeListeners.clear();
    });
  }

  private startWatcher(): void {
    void (async () => {
      try {
        for await (const event of this.stream.watchRoots(
          { roots: [this.root] },
          this.watchAbort.signal,
        )) {
          if (this.watchAbort.signal.aborted) break;
          this.handleWatchEvent(event);
        }
      } catch {
        // stream closed or aborted
      }
    })();
  }

  private handleWatchEvent(event: WorkspaceWatchEvent): void {
    const parts = event.relativePath.split("/").filter(Boolean);
    const parentRel = parts.slice(0, -1).join("/");

    if (
      event.type === "add" ||
      event.type === "unlink" ||
      event.type === "addDir" ||
      event.type === "unlinkDir"
    ) {
      if (this.dirCache.has(parentRel)) {
        void this.loadDir(parentRel, true);
      }
    }

    for (const listener of this.changeListeners) {
      listener(event);
    }
  }

  onFileChange(listener: FileChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  isLoadingDir(relativePath = ""): boolean {
    return this.loadingDirs.has(relativePath);
  }

  getDirResult(relativePath = ""): ReadDirResult | undefined {
    return this.dirCache.get(relativePath);
  }

  async loadDir(relativePath = "", force = false): Promise<ReadDirResult> {
    if (!force && this.dirCache.has(relativePath)) {
      return this.dirCache.get(relativePath)!;
    }
    if (this.loadingDirs.has(relativePath)) {
      return this.dirCache.get(relativePath) ?? { entries: [], truncated: false };
    }
    this.loadingDirs.add(relativePath);
    try {
      const result = await this.rpc.readDir({ root: this.root, relativePath });
      this.dirCache.set(relativePath, result);
      return result;
    } finally {
      this.loadingDirs.delete(relativePath);
    }
  }

  searchFiles(query: string, signal?: AbortSignal): Promise<{ paths: string[]; truncated: boolean }> {
    return this.rpc.searchFiles({ root: this.root, query }, signal);
  }

  async readFile(relativePath: string): Promise<ReadFileResult> {
    return await this.rpc.readFile({ root: this.root, relativePath });
  }

  async writeFile(
    relativePath: string,
    content: string,
    expectedMtimeMs?: number,
  ): Promise<{ mtimeMs: number; size: number }> {
    return await this.rpc.writeFile({
      root: this.root,
      relativePath,
      content,
      expectedMtimeMs,
    });
  }

  async createFile(relativePath: string, content = ""): Promise<void> {
    await this.rpc.createFile({ root: this.root, relativePath, content });
    const parentRel = relativePath.split("/").slice(0, -1).join("/");
    await this.loadDir(parentRel, true);
  }

  async createDir(relativePath: string): Promise<void> {
    await this.rpc.createDir({ root: this.root, relativePath });
    const parentRel = relativePath.split("/").slice(0, -1).join("/");
    await this.loadDir(parentRel, true);
  }

  async renamePath(oldRelativePath: string, newRelativePath: string): Promise<void> {
    await this.rpc.renamePath({ root: this.root, oldRelativePath, newRelativePath });
    const oldParent = oldRelativePath.split("/").slice(0, -1).join("/");
    const newParent = newRelativePath.split("/").slice(0, -1).join("/");
    void this.loadDir(oldParent, true).catch(console.error);
    if (newParent !== oldParent) {
      void this.loadDir(newParent, true).catch(console.error);
    }
  }

  async deletePath(relativePath: string): Promise<void> {
    await this.rpc.deletePath({ root: this.root, relativePath });
    const parentRel = relativePath.split("/").slice(0, -1).join("/");
    await this.loadDir(parentRel, true);
  }
}

export class UiWorkspaceService {
  readonly folderMenu = createWorkspaceFolderMenu();
  readonly fileMenu = createFileMenu();
  readonly files: readonly WorkspaceFile[] = seedWorkspaceFiles;
  readonly selectedFile: Ref<WorkspaceFile> = shallowRef(seedWorkspaceFiles[0]!);
  readonly browseRoot: Ref<string> = ref("");
  readonly activeWorkspaceId: Ref<string>;
  readonly workspaces: ComputedRef<readonly Workspace[]>;
  readonly currentWorkspace: ComputedRef<Workspace | undefined>;

  private readonly currentScope = inject(CurrentScope);
  private readonly storage = inject(UiStorageService);
  private readonly sessions = inject(UiSessionsService);
  private readonly rpc = inject(RpcClientService).use(WorkspaceRpcContract);
  private readonly workspaceSync = inject(StateSyncClientService).use(WorkspaceStateSyncContract);
  private readonly local = this.storage.use("core:ui-workspace:local", {
    activeWorkspaceId: z.string().default("default"),
  });

  private readonly rootScopes = new Map<
    string,
    { readonly scope: Scope; readonly service: WorkspaceRootService }
  >();
  private readonly treeStates = reactive(new Map<string, FileTreeState>());
  private readonly changeListeners = new Set<FileChangeListener>();

  readonly activeRoots: ComputedRef<string[]> = computed(() => {
    const current = this.sessions.current.value;
    if (current) {
      const raw = (current.meta as Record<string, unknown>).workspaceRoots;
      if (Array.isArray(raw)) {
        return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
      }
      const ws = this.getWorkspace(current.workspaceId) ?? this.currentWorkspace.value;
      if (ws) return [...ws.folders];
    }
    const workspace = this.currentWorkspace.value;
    return workspace ? [...workspace.folders] : [];
  });

  constructor() {
    this.activeWorkspaceId = toRef(this.local, "activeWorkspaceId");
    this.workspaces = computed(() => this.workspaceSync.items.items);
    this.currentWorkspace = computed(
      () =>
        this.workspaces.value.find((item) => item.id === this.activeWorkspaceId.value) ??
        this.workspaces.value[0],
    );

    void this.initBrowseRoot();

    watch(
      () => this.activeRoots.value,
      (roots) => {
        for (const root of roots) {
          const service = this.getRoot(root);
          if (!service.getDirResult("")) {
            void service.loadDir("");
          }
        }
      },
      { immediate: true, deep: true },
    );

    onScopeDispose(() => {
      for (const entry of this.rootScopes.values()) {
        entry.scope.dispose();
      }
      this.rootScopes.clear();
    });
  }

  private async initBrowseRoot(): Promise<void> {
    try {
      const { root } = await this.rpc.browseRoot({});
      this.browseRoot.value = root;
    } catch {
      // ignore when backend is unavailable
    }
  }

  getRoot(root: string): WorkspaceRootService {
    const existing = this.rootScopes.get(root);
    if (existing) return existing.service;

    const scope = this.currentScope.createChild({ id: `workspace-root:${root}` });
    scope.provide(WorkspaceRootService, createDescriptor(WorkspaceRootService, root));
    const service = scope.get(WorkspaceRootService);
    service.onFileChange((event) => {
      for (const listener of this.changeListeners) {
        listener(event);
      }
    });
    this.rootScopes.set(root, { scope, service });
    return service;
  }

  onFileChange(listener: FileChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  getFileTreeState(contextId: string, roots: readonly string[]): FileTreeState {
    let state = this.treeStates.get(contextId);
    if (!state) {
      state = reactive({
        expandedIds: roots.map((root) => workspaceNodeId(root, "")),
        selectedIds: [],
      });
      this.treeStates.set(contextId, state);
    }
    return state;
  }

  addRoot(root: string): void {
    const current = this.sessions.current.value;
    const trimmed = root.trim();
    if (!current || !trimmed) return;
    if (
      !Array.isArray((current.meta as Record<string, unknown>).workspaceRoots) &&
      this.getWorkspace(current.workspaceId)
    ) {
      this.addFolder(current.workspaceId, trimmed);
      return;
    }
    const next = [...this.activeRoots.value];
    if (next.includes(trimmed)) return;
    next.push(trimmed);
    (current.meta as Record<string, unknown>).workspaceRoots = next;
    this.sessions.commitMeta(current.id);
  }

  removeRoot(root: string): void {
    const current = this.sessions.current.value;
    if (!current) return;
    if (
      !Array.isArray((current.meta as Record<string, unknown>).workspaceRoots) &&
      this.getWorkspace(current.workspaceId)
    ) {
      this.removeFolder(current.workspaceId, root);
      return;
    }
    const next = this.activeRoots.value.filter((item) => item !== root);
    if (next.length === 0) return;
    (current.meta as Record<string, unknown>).workspaceRoots = next;
    this.sessions.commitMeta(current.id);
  }

  reorderRoots(roots: string[]): void {
    const current = this.sessions.current.value;
    if (!current) return;
    (current.meta as Record<string, unknown>).workspaceRoots = [...roots];
    this.sessions.commitMeta(current.id);
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.value.find((item) => item.id === id);
  }

  createWorkspace(options: {
    readonly name?: string;
    readonly folders: readonly string[];
    readonly instructions?: string;
  }): Workspace {
    const folders = options.folders
      .map((folder) => folder.trim())
      .filter((folder) => folder.length > 0);
    if (folders.length === 0) {
      throw new Error("A workspace requires at least one folder");
    }
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: options.name?.trim() || "New workspace",
      folders,
      instructions: options.instructions ?? "",
    };
    this.workspaceSync.items.items.push(workspace);
    this.local.activeWorkspaceId = workspace.id;
    return workspace;
  }

  openFolder(folder: string): Workspace {
    const trimmed = folder.trim();
    if (!trimmed) throw new Error("A folder is required");
    const existing = this.workspaces.value.find((item) => item.folders.includes(trimmed));
    if (existing) {
      this.local.activeWorkspaceId = existing.id;
      return existing;
    }
    const name =
      trimmed
        .split(/[\\/]/)
        .filter((part) => part.length > 0)
        .at(-1) ?? trimmed;
    return this.createWorkspace({ name, folders: [trimmed] });
  }

  duplicateWorkspace(sourceId: string): Workspace | undefined {
    const source = this.getWorkspace(sourceId);
    if (!source) return undefined;
    return this.createWorkspace({
      name: `${source.name} (Copy)`,
      folders: [...source.folders],
      instructions: source.instructions,
    });
  }

  renameWorkspace(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const list = this.workspaceSync.items.items;
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return;
    list[index] = { ...list[index]!, name: trimmed };
  }

  addFolder(id: string, folder: string): boolean {
    const trimmed = folder.trim();
    if (!trimmed) return false;
    const list = this.workspaceSync.items.items;
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const current = list[index]!;
    if (current.folders.includes(trimmed)) return false;
    list[index] = {
      ...current,
      folders: [...current.folders, trimmed],
    };
    return true;
  }

  removeFolder(id: string, folder: string): void {
    const list = this.workspaceSync.items.items;
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return;
    const current = list[index]!;
    const folders = current.folders.filter((item) => item !== folder);
    if (folders.length === 0) return;
    list[index] = { ...current, folders };
  }

  updateFolder(id: string, index: number, folder: string): boolean {
    const trimmed = folder.trim();
    if (!trimmed) return false;
    const list = this.workspaceSync.items.items;
    const wsIndex = list.findIndex((item) => item.id === id);
    if (wsIndex === -1) return false;
    const current = list[wsIndex]!;
    if (index < 0 || index >= current.folders.length) return false;
    if (current.folders[index] === trimmed) return true;
    if (current.folders.some((item, idx) => idx !== index && item === trimmed)) return false;
    const nextFolders = [...current.folders];
    nextFolders[index] = trimmed;
    list[wsIndex] = {
      ...current,
      folders: nextFolders,
    };
    return true;
  }

  updateInstructions(id: string, instructions: string): void {
    const list = this.workspaceSync.items.items;
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return;
    list[index] = {
      ...list[index]!,
      instructions,
    };
  }

  removeWorkspace(id: string): void {
    const list = this.workspaceSync.items.items;
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return;
    list.splice(index, 1);
    if (this.local.activeWorkspaceId === id) {
      this.local.activeWorkspaceId = list[0]?.id ?? "default";
    }
  }

  selectFile(file: WorkspaceFile): void {
    this.selectedFile.value = file;
  }
}

export { default as WorkspacePanel } from "./panels/WorkspacePanel.vue";
export { default as FilesPanel } from "./panels/FilesPanel.vue";
export { default as ChangesPanel } from "./panels/ChangesPanel.vue";
export { WorkspaceTabDescriptor, openWorkspaceTab } from "./tabs/WorkspaceTab.ts";
