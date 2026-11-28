<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: TreeView. Adaptation: retain the selected conversation's focus colors while its chat tab has focus. -->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from "vue";
import { UiSessionStatusService } from "@harness/session-status";
import { openChatTab } from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { ContextMenu, IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiSessionsService } from "@harness/ui-sessions";
import {
  TreeView,
  type ContextMenuAnchor,
  type TreeAction,
  type TreeNode,
} from "@harness/ui-tree-view";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  openWorkspaceTab,
  UiWorkspaceService,
  WorkspaceTabDescriptor,
} from "@harness/ui-workspace";

const workbench = useService(UiWorkbenchService);
const tabs = useService(UiTabsService);
const workspaceService = useService(UiWorkspaceService);
const sessionsService = useService(UiSessionsService);
const sessionStatus = useService(UiSessionStatusService);
const chat = useService(UiChatManagerService);

const workspaces = workspaceService.workspaces;
const sessionList = sessionsService.sessions;
const viewport = ref<HTMLElement>();
const treeHeight = ref(0);
const tree = ref<InstanceType<typeof TreeView>>();
const expandedIds = ref<string[]>([]);
const selectedId = ref("");
const focusedId = ref<string>();
const editingId = ref("");
const renameDraft = ref("");
const renameInvalid = computed(() => Boolean(editingId.value) && !renameDraft.value.trim());
const renameErrorId = useId();
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuTarget = shallowRef<{ nodeId?: string; workspaceId?: string }>({});
const contextMenuOpen = ref(false);

const sessionActions: readonly TreeAction[] = [
  { id: "rename", label: "Rename conversation", icon: "i-codicon-edit" },
  { id: "open-tab", label: "Open in new tab", icon: "i-codicon-open-preview" },
  { id: "delete", label: "Delete conversation…", icon: "i-codicon-trash" },
];
const workspaceActions: readonly TreeAction[] = [
  { id: "rename-workspace", label: "Rename workspace", icon: "i-codicon-edit" },
  { id: "duplicate-workspace", label: "Duplicate workspace", icon: "i-codicon-copy" },
  { id: "delete-workspace", label: "Delete workspace…", icon: "i-codicon-trash" },
];

function toSessionNode(session: (typeof sessionList.value)[number]): TreeNode {
  const status = sessionStatus.present(session.id);
  return {
    id: session.id,
    label: session.title,
    description: status.description,
    icon: status.icon,
    decoration: status,
    actions: sessionActions,
  };
}

const treeNodes = computed<TreeNode[]>(() => {
  const workspaceIds = new Set(workspaces.value.map(({ id }) => id));
  const workspaceNodes = workspaces.value.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    label: workspace.name,
    icon: "i-codicon-folder-library",
    children: sessionList.value
      .filter((session) => session.workspaceId === workspace.id)
      .map(toSessionNode),
    actions: workspaceActions,
  }));
  const ungrouped = sessionList.value
    .filter((session) => !workspaceIds.has(session.workspaceId))
    .map(toSessionNode);
  return [...ungrouped, ...workspaceNodes];
});

function expandWorkspace(id: string) {
  const nodeId = `workspace:${id}`;
  if (workspaceService.getWorkspace(id) && !expandedIds.value.includes(nodeId)) {
    expandedIds.value = [...expandedIds.value, nodeId];
  }
}

watch(
  () => workspaces.value.map(({ id }) => id),
  (ids, previous) => {
    for (const id of ids) {
      if (!previous?.includes(id)) expandWorkspace(id);
    }
  },
  { immediate: true },
);
watch(
  () => sessionsService.current.value?.id,
  (id) => {
    const session = sessionList.value.find((item) => item.id === id);
    selectedId.value = session?.id ?? "";
    if (session) expandWorkspace(session.workspaceId);
  },
  { immediate: true },
);
watch(
  () => tabs.groups.value.find((group) => group.isActive)?.activeTabId,
  (id) => {
    const descriptor = id ? tabs.get(id)?.descriptor : undefined;
    if (descriptor instanceof WorkspaceTabDescriptor) {
      selectedId.value = `workspace:${descriptor.workspaceId}`;
    }
  },
);
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

const visibleSelectedIds = computed({
  get: () => (selectedId.value ? [selectedId.value] : []),
  set: ([id]: string[]) => {
    if (!id) return;
    selectedId.value = id;
    if (id.startsWith("workspace:")) {
      const workspace = workspaceService.getWorkspace(id.slice("workspace:".length));
      if (workspace) openWorkspaceTab(tabs, workspaceService, workspace);
    } else {
      const session = sessionList.value.find((item) => item.id === id);
      if (!session) return;
      workspaceService.activeWorkspaceId.value = session.workspaceId;
      sessionsService.activeId.value = id;
      workbench.open("chat");
      focusChatComposer();
    }
  },
});

function createConversation(workspaceId: string) {
  workspaceService.activeWorkspaceId.value = workspaceId;
  expandWorkspace(workspaceId);
  sessionsService.newSession(workspaceId);
  workbench.open("chat");
  focusChatComposer();
}

function focusChatComposer() {
  void nextTick(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      '.dv-active-group .chat-panel textarea[aria-label="Message Harness"]',
    );
    if (composer?.getClientRects().length && !composer.closest("[inert]")) {
      composer.focus({ preventScroll: true });
    }
  });
}

function preserveComposerFocus(event: MouseEvent) {
  if (event.button !== 0 || !document.activeElement?.closest(".chat-panel .composer")) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLElement>(".vc-tree-row");
  if (!row?.dataset.id || row.dataset.id.startsWith("workspace:")) return;
  const control = target.closest(
    "button, input, textarea, select, a[href], [contenteditable], [tabindex]",
  );
  if (control && row.contains(control)) return;
  event.preventDefault();
  event.stopPropagation();
}

async function startRename(id: string) {
  const session = sessionList.value.find((item) => item.id === id);
  const workspace = id.startsWith("workspace:") ? workspaceService.getWorkspace(id.slice("workspace:".length)) : undefined;
  if (!session && !workspace) return;
  editingId.value = id;
  renameDraft.value = workspace?.name ?? session!.title;
  await nextTick();
  const input = viewport.value?.querySelector<HTMLInputElement>(".session-rename");
  input?.focus();
  input?.select();
}

function finishRename(commit: boolean, restoreFocus = true) {
  const id = editingId.value;
  const title = renameDraft.value.trim();
  if (!id || (commit && !title && restoreFocus)) return;
  editingId.value = "";
  if (commit && title) {
    if (id.startsWith("workspace:")) workspaceService.renameWorkspace(id.slice("workspace:".length), title);
    else sessionsService.renameSession(id, title);
  }
  if (!restoreFocus) return;
  void nextTick(() => {
    const hasRow = treeNodes.value.some(
      (node) => node.id === id || node.children?.some((child) => child.id === id),
    );
    tree.value?.focus(hasRow ? id : undefined);
  });
}

function renameFocused(event: KeyboardEvent) {
  const id = focusedId.value ?? selectedId.value;
  if (!id) return;
  event.preventDefault();
  void startRename(id);
}

function onRenameKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    finishRename(event.key === "Enter");
  }
}

function deleteWorkspace(id: string, name: string) {
  const sessions = sessionList.value.filter((session) => session.workspaceId === id);
  const message = sessions.length
    ? `Delete “${name}” and its ${sessions.length === 1 ? "conversation" : `${sessions.length} conversations`}?`
    : `Delete “${name}”?`;
  if (!window.confirm(message)) return;
  const keys = new Set([`workspace:${id}`, ...sessions.map((session) => `chat:${session.id}`)]);
  for (const tab of tabs.tabs.values()) {
    if (keys.has(tab.descriptor.key)) tabs.close(tab.tabId);
  }
  workspaceService.removeWorkspace(id);
  sessionsService.removeWorkspaceSessions(id);
  if (selectedId.value === `workspace:${id}`) {
    selectedId.value = sessionsService.current.value?.id ?? "";
  }
}

function onAction(action: TreeAction, node: TreeNode) {
  switch (action.id) {
    case "duplicate-workspace": {
      const copy = workspaceService.duplicateWorkspace(node.id.slice("workspace:".length));
      if (copy) {
        selectedId.value = `workspace:${copy.id}`;
        openWorkspaceTab(tabs, workspaceService, copy);
      }
      break;
    }
    case "delete-workspace":
      deleteWorkspace(node.id.slice("workspace:".length), node.label);
      break;
    case "rename-workspace":
    case "rename":
      void startRename(node.id);
      break;
    case "open-tab": {
      const session = sessionList.value.find((item) => item.id === node.id);
      if (session) openChatTab(tabs, sessionsService, chat, session);
      break;
    }
    case "delete":
      if (window.confirm(`Delete “${node.label}”?`)) {
        for (const tab of tabs.tabs.values()) {
          if (tab.descriptor.key === `chat:${node.id}`) tabs.close(tab.tabId);
        }
        sessionsService.removeSession(node.id);
      }
      break;
  }
}

const menuNode = computed(() => treeNodes.value.flatMap((node) => [node, ...(node.children ?? [])])
  .find((node) => node.id === menuTarget.value.nodeId));
const menuGroups = computed(() => {
  const node = menuNode.value;
  if (menuTarget.value.nodeId && !node) return [];
  const workspaceId = node?.id.startsWith("workspace:") ? node.id.slice("workspace:".length) : menuTarget.value.workspaceId;
  const openFolder = workbench.panels().find((panel) => panel.id === "sessions")?.titleActions
    ?.find((action) => action.id === "open-folder-as-workspace");
  return sessionsService.menu.resolve({
    node, workspaceId, canCollapse: !!expandedIds.value.length,
    createConversation: () => {
      if (workspaceId) createConversation(workspaceId);
      else { sessionsService.newSession(); workbench.open("chat"); focusChatComposer(); }
    },
    open: () => { if (node) visibleSelectedIds.value = [node.id]; },
    runAction: (action) => { if (node) void onAction(action, node); },
    openFolder: openFolder?.run,
    collapseAll: () => { expandedIds.value = []; },
  });
});

async function openContextMenu(
  node: TreeNode | undefined,
  event: MouseEvent | KeyboardEvent,
  anchor?: ContextMenuAnchor,
) {
  menuTarget.value = { nodeId: node?.id, workspaceId: workspaceService.currentWorkspace.value?.id };
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const focusTarget = viewport.value?.querySelector<HTMLElement>('[role="tree"]');
  const menuAnchor = event instanceof MouseEvent ? event : anchor instanceof HTMLElement ? anchor : focusTarget;
  if (!menuAnchor) return;
  await nextTick();
  contextMenu.value?.show(menuAnchor, focusTarget ?? undefined);
}

function onBackgroundKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]")) return;
  void openContextMenu(undefined, event);
}
</script>

<template>
  <section
    class="sessions-panel panel-fill"
    :class="{ 'current-conversation-selected': selectedId === sessionsService.current.value?.id }"
    @mousedown.capture="preserveComposerFocus"
  >
    <div ref="viewport" class="navigator-viewport" @keydown="onBackgroundKeydown" @contextmenu="openContextMenu(undefined, $event)">
      <TreeView
        v-if="treeNodes.length"
        ref="tree"
        v-model:expanded-ids="expandedIds"
        v-model:selected-ids="visibleSelectedIds"
        :nodes="treeNodes"
        :multiple="false"
        :height="treeHeight"
        aria-label="Conversations"
        @contextmenu="openContextMenu"
        @focus-change="focusedId = $event"
        @keydown.f2="renameFocused"
      >
        <template #label="{ node }">
          <input
            v-if="editingId === node.id"
            v-model="renameDraft"
            class="session-rename"
            :class="{ invalid: renameInvalid }"
            :aria-label="editingId.startsWith('workspace:') ? 'Workspace name' : 'Conversation title'"
            :aria-invalid="renameInvalid ? 'true' : undefined"
            :aria-describedby="renameInvalid ? renameErrorId : undefined"
            spellcheck="false"
            autocomplete="off"
            @mousedown.stop
            @click.stop
            @contextmenu.stop
            @keydown.stop="onRenameKeydown"
            @blur="finishRename(true, false)"
          />
          <span v-else class="vc-tree-label" :title="node.label">{{ node.label }}</span>
        </template>
        <template #actions="{ node }">
          <IconButton
            v-if="node.id.startsWith('workspace:')"
            class="workspace-add"
            icon="i-codicon-new-session"
            label="New conversation here"
            :title="`New conversation in ${node.label}`"
            @click.stop="createConversation(node.id.slice('workspace:'.length))"
          />
        </template>
      </TreeView>
      <p v-else class="empty-hint" role="status">No conversations yet.</p>
    </div>
    <p v-if="renameInvalid" :id="renameErrorId" class="navigator-error" role="alert">
      Enter a name.
    </p>
    <ContextMenu ref="contextMenu" v-model:open="contextMenuOpen" :groups="menuGroups"
      :label="menuNode ? `Actions for ${menuNode.label}` : 'Conversations actions'" />
  </section>
</template>

<style scoped>
.dockview:has(.dv-groupview:focus-within .chat-panel)
  .sessions-panel.current-conversation-selected
  :deep(.vc-tree-row.selected) {
  background: var(--active-selection);
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}

.navigator-viewport {
  flex: 1;
  min-height: 0;
}

.navigator-viewport :deep(.vc-tree-row .actions:empty) {
  display: none;
}

.navigator-viewport :deep(.vc-tree-row .actions:has(.workspace-add)) {
  display: flex;
}

.workspace-add:hover,
.workspace-add:focus-visible {
  color: var(--strong);
}

.navigator-viewport :deep(.vc-tree-row .vc-tree-description) {
  display: block;
  max-width: 38%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-rename {
  flex: 1;
}

.navigator-error {
  padding: 4px 8px;
  color: var(--error-fg);
  background: var(--error-bg);
  font-size: 12px;
}
</style>
