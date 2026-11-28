<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: Explorer, ExplorerTree, ContextMenu
  Adaptation: Workspace-scoped file commands on the Harness tree.
-->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from "vue";
import { Button, ContextMenu, IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { FileEditorService, openFileEditorTab } from "@harness/ui-editor";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiSessionsService } from "@harness/ui-sessions";
import { TreeView, type ContextMenuAnchor, type TreeNode } from "@harness/ui-tree-view";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  parseWorkspaceNodeId,
  UiWorkspaceService,
  workspaceNodeId,
  type WorkspaceEntry,
  type FileMenuContext,
  type FileMenuTarget,
} from "@harness/ui-workspace";

const workspace = useService(UiWorkspaceService);
const filePicker = useService(UiFilePickerService);
const sessions = useService(UiSessionsService);
const tabs = useService(UiTabsService);
const workbench = useService(UiWorkbenchService);
const editor = useService(FileEditorService);
const notifications = useService(UiNotificationService);

const viewport = ref<HTMLElement>();
const tree = ref<InstanceType<typeof TreeView>>();
const treeHeight = ref(0);
const focusedId = ref<string>();
const isMac = navigator.platform.includes("Mac");

type FileTarget = FileMenuTarget;
type CreateAction = "new-file" | "new-folder";
type NameAction = CreateAction | "rename";
const nameLabels: Record<NameAction, string> = {
  "new-file": "New file name",
  "new-folder": "New folder name",
  rename: "Rename to",
};
const editing = shallowRef<{ action: NameAction; target: FileTarget; rowId: string }>();
const draftName = ref("");
const nameError = ref("");
const nameErrorId = useId();
const menu = shallowRef<{ context: Pick<FileMenuContext, "target" | "treeContextId">; label: string }>();
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuOpen = ref(false);

const currentWorkspace = workspace.currentWorkspace;
const folderAction = computed(() => (currentWorkspace.value ? "Add Folder" : "Open Folder"));
const folderActionLabel = computed(() =>
  currentWorkspace.value ? "Add Folder to Workspace" : folderAction.value,
);
const roots = computed(() => currentWorkspace.value?.folders ?? workspace.activeRoots.value);
const treeContextId = computed(() => {
  const current = currentWorkspace.value;
  return current ? `workspace:${current.id}` : `session:${sessions.current.value?.id ?? ""}`;
});
const treeState = computed(() => workspace.getFileTreeState(treeContextId.value, roots.value));

const expandedIds = computed({
  get: () => treeState.value.expandedIds,
  set: (ids: string[]) => {
    treeState.value.expandedIds = ids;
  },
});

const selectedIds = computed({
  get: () => treeState.value.selectedIds,
  set: (ids: string[]) => {
    treeState.value.selectedIds = ids;
    const target = getTarget(ids[0]);
    if (target && !target.isDirectory) {
      void openFileEditorTab(tabs, editor, { ...target, preview: true });
    }
  },
});

watch([treeState, roots], ([state, folders], [previousState, previousFolders]) => {
  if (state !== previousState) {
    focusedId.value = undefined;
    editing.value = undefined;
    menuOpen.value = false;
    menu.value = undefined;
    return;
  }
  if (editing.value && !folders.includes(editing.value.target.root)) cancelEdit(false);
  if (menu.value?.context.target && !folders.includes(menu.value.context.target.root)) {
    menuOpen.value = false;
    menu.value = undefined;
  }
  const newRootIds = folders
    .filter((root) => !previousFolders.includes(root))
    .map((root) => workspaceNodeId(root, ""));
  if (newRootIds.length) state.expandedIds = [...new Set([...state.expandedIds, ...newRootIds])];
});

watch(viewport, (element, _, onCleanup) => {
  if (!element) return;
  const measure = () => {
    treeHeight.value = element.clientHeight;
  };
  const observer = new ResizeObserver(measure);
  measure();
  observer.observe(element);
  onCleanup(() => observer.disconnect());
});

watch(
  expandedIds,
  (ids) => {
    for (const id of ids) {
      const parsed = parseWorkspaceNodeId(id);
      if (!parsed || !roots.value.includes(parsed.root)) continue;
      const rootService = workspace.getRoot(parsed.root);
      if (!rootService.getDirResult(parsed.relativePath)) {
        void rootService.loadDir(parsed.relativePath);
      }
    }
  },
  { immediate: true },
);

function iconForEntry(entry: WorkspaceEntry, isExpanded: boolean): string {
  const contributed = workbench.getFileIconClass(entry.name, {
    folder: entry.type === "directory",
    expanded: isExpanded,
  });
  if (contributed) return contributed;
  if (entry.type === "directory") {
    return isExpanded ? "i-codicon-folder-opened" : "i-codicon-folder";
  }
  const ext = entry.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (ext === "vue") return "i-codicon-symbol-color";
  if (ext === "json") return "i-codicon-json";
  if (ext === "md") return "i-codicon-markdown";
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
    return "i-codicon-symbol-class";
  }
  return "i-codicon-file";
}

function buildChildren(root: string, relativePath: string): TreeNode[] {
  const rootService = workspace.getRoot(root);
  const dir = rootService.getDirResult(relativePath);
  const edit = editing.value;
  const newNode =
    edit &&
    edit.action !== "rename" &&
    edit.target.root === root &&
    edit.target.relativePath === relativePath
      ? {
          id: edit.rowId,
          label: nameLabels[edit.action],
          icon: edit.action === "new-folder" ? "i-codicon-folder" : "i-codicon-file",
        }
      : undefined;
  if (!dir) {
    if (newNode) return [newNode];
    return [
      {
        id: `loading:${root}::${relativePath}`,
        label: rootService.isLoadingDir(relativePath) ? "Loading..." : "...",
        icon: "i-codicon-loading",
      },
    ];
  }

  const children: TreeNode[] = dir.entries.map((entry) => {
    const id = workspaceNodeId(root, entry.relativePath);
    const isExpanded = expandedIds.value.includes(id);
    const isDirty = entry.type === "file" && editor.isDirty(entry.path);

    return {
      id,
      label: entry.name,
      icon: iconForEntry(entry, isExpanded),
      decoration: isDirty ? { badge: "●", color: "var(--modified)" } : undefined,
      children: entry.type === "directory" ? buildChildren(root, entry.relativePath) : undefined,
    };
  });
  if (newNode) children.unshift(newNode);
  return children;
}

const treeNodes = computed<TreeNode[]>(() => {
  const folders = roots.value;
  const names = folders.map((root) => root.split("/").filter(Boolean).at(-1) ?? root);
  const duplicateNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  return folders.map((root, index) => {
    const id = workspaceNodeId(root, "");
    const label = names[index]!;
    return {
      id,
      label,
      description: duplicateNames.has(label) ? root : undefined,
      decoration: { tooltip: root },
      icon:
        workbench.getFileIconClass(root, {
          folder: true,
          root: true,
          expanded: expandedIds.value.includes(id),
        }) ??
        (expandedIds.value.includes(id) ? "i-codicon-root-folder-opened" : "i-codicon-root-folder"),
      children: buildChildren(root, ""),
    };
  });
});

const canCollapse = computed(() =>
  treeNodes.value.some((node) => node.children?.length && expandedIds.value.includes(node.id)),
);

async function pickRootFolder() {
  const workspaceId = currentWorkspace.value?.id;
  const picked = await filePicker.pickFolder({
    title: folderActionLabel.value,
    confirmLabel: folderAction.value,
    initialPath: roots.value[0] ?? workspace.browseRoot.value,
  });
  if (!picked || workspaceId !== currentWorkspace.value?.id) return;
  if (workspaceId) workspace.addFolder(workspaceId, picked);
  else workspace.openFolder(picked);
}

function collapseAll() {
  expandedIds.value = [];
}

function refreshAll() {
  const directories = new Map(roots.value.map((root) => [root, new Set([""])] as const));
  for (const id of expandedIds.value) {
    const folder = parseWorkspaceNodeId(id);
    if (folder) directories.get(folder.root)?.add(folder.relativePath);
  }
  for (const [root, paths] of directories) {
    const service = workspace.getRoot(root);
    for (const relativePath of paths) {
      void service.loadDir(relativePath, true).catch(console.error);
    }
  }
}

function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function getTarget(id?: string): FileTarget | undefined {
  const parsed = id ? parseWorkspaceNodeId(id) : undefined;
  if (!parsed || !roots.value.includes(parsed.root)) return;
  if (!parsed.relativePath) return { ...parsed, isDirectory: true };
  const dir = workspace.getRoot(parsed.root).getDirResult(parentPath(parsed.relativePath));
  const entry = dir?.entries.find((item) => item.relativePath === parsed.relativePath);
  if (entry) return { ...parsed, isDirectory: entry.type === "directory" };
}

function createFromToolbar(action: CreateAction) {
  const root = roots.value[0];
  if (!root) return;
  const target = getTarget(focusedId.value) ?? getTarget(selectedIds.value[0]);
  const parent = target
    ? target.isDirectory
      ? target
      : { root: target.root, relativePath: parentPath(target.relativePath), isDirectory: true }
    : { root, relativePath: "", isDirectory: true };
  void startEdit(action, parent);
}

async function startEdit(action: NameAction, target: FileTarget) {
  const id = workspaceNodeId(target.root, target.relativePath);
  const edit = { action, target, rowId: action === "rename" ? id : `new:${id}` };
  draftName.value = action === "rename" ? target.relativePath.split("/").at(-1)! : "";
  nameError.value = "";
  editing.value = edit;
  if (action !== "rename") {
    const ancestors = [workspaceNodeId(target.root)];
    const segments = target.relativePath.split("/").filter(Boolean);
    segments.forEach((_, index) => {
      ancestors.push(workspaceNodeId(target.root, segments.slice(0, index + 1).join("/")));
    });
    expandedIds.value = [...new Set([...expandedIds.value, ...ancestors])];
  }
  await nextTick();
  if (editing.value !== edit) return;
  tree.value?.reveal(edit.rowId);
  await nextTick();
  if (editing.value !== edit) return;
  const input = viewport.value?.querySelector<HTMLInputElement>(".files-name-input");
  input?.focus();
  const dot = draftName.value.lastIndexOf(".");
  if (action === "rename" && !target.isDirectory && dot > 0) input?.setSelectionRange(0, dot);
  else input?.select();
}

function cancelEdit(restoreFocus: boolean) {
  const edit = editing.value;
  if (!edit) return;
  editing.value = undefined;
  if (restoreFocus) tree.value?.focus(workspaceNodeId(edit.target.root, edit.target.relativePath));
}

async function confirmEdit(restoreFocus: boolean) {
  const edit = editing.value;
  if (!edit) return;
  const { action, target } = edit;
  const { root, relativePath } = target;
  const name = draftName.value.trim();
  if (action === "rename" && name === relativePath.split("/").at(-1)) {
    cancelEdit(restoreFocus);
    return;
  }
  const pathParts = name.split("/");
  if (
    !name ||
    (action === "rename" && /[\\/]/.test(name)) ||
    pathParts.some((part) => !part.trim() || part === "." || part === "..")
  ) {
    if (restoreFocus) nameError.value = name ? "Enter a valid name." : "Enter a name.";
    else cancelEdit(false);
    return;
  }

  const folder = action === "rename" ? parentPath(relativePath) : relativePath;
  const destination = folder ? `${folder}/${name}` : name;
  const rootService = workspace.getRoot(root);
  if (
    rootService
      .getDirResult(parentPath(destination))
      ?.entries.some((entry) => entry.relativePath === destination)
  ) {
    if (restoreFocus) nameError.value = "An item with that name already exists.";
    else cancelEdit(false);
    return;
  }

  const state = treeState.value;
  cancelEdit(restoreFocus);
  try {
    if (action === "new-file") {
      await rootService.createFile(destination, "");
      if (treeState.value === state && roots.value.includes(root)) {
        await openFileEditorTab(tabs, editor, { root, relativePath: destination, preview: false });
      }
    } else if (action === "new-folder") {
      await rootService.createDir(destination);
    } else if (target.isDirectory) {
      await rootService.renamePath(relativePath, destination);
    } else {
      await editor.renameDocument(root, relativePath, destination);
      state.selectedIds = state.selectedIds.map((id) =>
        id === edit.rowId ? workspaceNodeId(root, destination) : id,
      );
    }
  } catch (error) {
    notifications.notify(error instanceof Error ? error.message : "File operation failed.");
  }
}

async function openMenu(
  node: TreeNode | undefined,
  event: MouseEvent | KeyboardEvent,
  anchor?: ContextMenuAnchor,
) {
  const target = getTarget(node?.id);
  if (node && !target) return;
  menu.value = { context: { target, treeContextId: treeContextId.value }, label: node?.label ?? "Files" };
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const focusTarget = viewport.value?.querySelector<HTMLElement>('[role="tree"]');
  const menuAnchor = event instanceof MouseEvent ? event : anchor instanceof HTMLElement ? anchor : focusTarget;
  if (!menuAnchor) return;
  await nextTick();
  contextMenu.value?.show(menuAnchor, focusTarget ?? undefined);
}

const menuGroups = computed(() => {
  const context = menu.value?.context;
  if (!context || context.treeContextId !== treeContextId.value) return [];
  const target = context.target;
  if (target && !getTarget(workspaceNodeId(target.root, target.relativePath))) return [];
  return workspace.fileMenu.resolve({
    ...context,
    rootCount: roots.value.length,
    canCollapse: canCollapse.value,
    folderActionLabel: folderActionLabel.value,
    isMac,
    open: async () => { if (target) await openFileEditorTab(tabs, editor, { ...target, preview: false }); },
    create: (action) => { if (target) void startEdit(action, target); else createFromToolbar(action); },
    copyPath: async (relative) => { if (target) await copyPath(target, relative); },
    rename: async () => { if (target) await startEdit("rename", target); },
    delete: async () => { if (target) await deleteTarget(target); },
    pickRoot: pickRootFolder,
    removeRoot: () => { if (target) removeRoot(target.root); },
    refresh: refreshAll,
    collapseAll,
  });
});

async function copyPath(target: FileTarget, relative: boolean) {
  const { root, relativePath } = target;
  let path = root;
  if (relative) {
    const rootName = root.split("/").filter(Boolean).at(-1) ?? root;
    path =
      roots.value.length > 1
        ? [rootName, relativePath].filter(Boolean).join("/")
        : relativePath || ".";
  } else if (relativePath) {
    path = `${root.replace(/\/+$/, "")}/${relativePath}`;
  }
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    notifications.notify("Could not copy the path.");
  }
}

function removeRoot(root: string) {
  if (currentWorkspace.value) workspace.removeFolder(currentWorkspace.value.id, root);
  else workspace.removeRoot(root);
}

async function deleteTarget(target: FileTarget) {
  if (!window.confirm(`Permanently delete “${target.relativePath}”?`)) return;
  try {
    await workspace.getRoot(target.root).deletePath(target.relativePath);
  } catch (error) {
    notifications.notify(error instanceof Error ? error.message : "Could not delete the item.");
  }
}

function onTreeKeydown(event: KeyboardEvent) {
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tree")
    return;
  const target = getTarget(focusedId.value);
  if (!target?.relativePath) return;
  const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  const rename = unmodified && (event.key === "F2" || (isMac && event.key === "Enter"));
  const remove = event.key === "Delete" || (isMac && event.metaKey && event.key === "Backspace");
  if (!rename && !remove) return;
  event.stopPropagation();
  event.preventDefault();
  if (rename) void startEdit("rename", target);
  else void deleteTarget(target);
}

function onNameKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void confirmEdit(true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelEdit(true);
  }
}
function onBackgroundKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]")) return;
  void openMenu(undefined, event);
}
</script>

<template>
  <section class="panel-fill files-panel" @keydown="onBackgroundKeydown" @contextmenu="openMenu(undefined, $event)">
    <div v-if="treeNodes.length === 0" class="files-empty">
      <p>{{ currentWorkspace ? "No folders yet." : "Open a folder to start a workspace." }}</p>
      <Button variant="primary" @click="pickRootFolder">{{ folderAction }}</Button>
    </div>

    <template v-else>
      <div class="files-toolbar">
        <span class="files-toolbar-title" :title="currentWorkspace?.name">{{
          currentWorkspace?.name ?? "Folders"
        }}</span>
        <div class="files-toolbar-actions" role="toolbar" aria-label="File actions">
          <IconButton
            icon="i-codicon-new-file"
            label="New File"
            @click="createFromToolbar('new-file')"
          />
          <IconButton
            icon="i-codicon-new-folder"
            label="New Folder"
            @click="createFromToolbar('new-folder')"
          />
          <IconButton icon="i-codicon-refresh" label="Refresh Explorer" @click="refreshAll" />
          <IconButton
            icon="i-codicon-collapse-all"
            label="Collapse Folders"
            :disabled="!canCollapse"
            @click="collapseAll"
          />
        </div>
      </div>

      <div ref="viewport" class="files-viewport" @keydown.capture="onTreeKeydown">
        <TreeView
          :key="treeContextId"
          ref="tree"
          v-model:expanded-ids="expandedIds"
          v-model:selected-ids="selectedIds"
          :nodes="treeNodes"
          :multiple="false"
          :height="treeHeight"
          expand-on-label
          aria-label="Explorer"
          @contextmenu="openMenu"
          @focus-change="focusedId = $event"
        >
          <template #label="{ node }">
            <input
              v-if="editing && editing.rowId === node.id"
              v-model="draftName"
              class="files-name-input"
              :aria-label="nameLabels[editing.action]"
              :aria-invalid="nameError ? 'true' : undefined"
              :aria-describedby="nameError ? nameErrorId : undefined"
              autocomplete="off"
              spellcheck="false"
              @mousedown.stop
              @click.stop
              @contextmenu.stop
              @keydown.stop="onNameKeydown"
              @blur="confirmEdit(false)"
              @input="nameError = ''"
            />
            <span v-else class="vc-tree-label">{{ node.label }}</span>
          </template>
        </TreeView>
      </div>
      <p v-if="editing && nameError" :id="nameErrorId" class="files-name-error" role="alert">
        {{ nameError }}
      </p>
    </template>

    <ContextMenu ref="contextMenu" v-model:open="menuOpen" :groups="menuGroups"
      :label="`Actions for ${menu?.label ?? 'Files'}`" />
  </section>
</template>

<style scoped>
.files-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.files-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 8px;
  padding: 4px 8px 4px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
}

.files-toolbar-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.files-toolbar-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.files-toolbar-actions :disabled {
  background: transparent;
  color: var(--muted);
  cursor: default;
  opacity: 0.45;
}

.files-viewport {
  flex: 1;
  min-height: 0;
}

.files-viewport :deep(.vc-tree-description) {
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
}

.files-name-input {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0 3px;
  border: 1px solid var(--selection-border);
  border-radius: 2px;
  background: var(--input);
  color: var(--fg);
  font: inherit;
  outline: none;
}

.files-name-input[aria-invalid="true"] {
  border-color: var(--red);
}

.files-name-error {
  margin: 0;
  padding: 4px 10px;
  color: var(--red);
  font-size: 12px;
}



.files-empty {
  padding: 20px 14px;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
</style>
