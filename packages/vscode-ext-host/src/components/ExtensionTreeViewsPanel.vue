<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: TreeView
  Adaptation: Lazy extension trees with full-width rows and compact 8px child indentation.
-->
<script setup lang="ts">
import { ViewProgressSlot } from "@harness/ui-workbench";
import { inject } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import { ContextMenu } from "@harness/ui-menu";
import { ExtensionHostClientService } from "../client.ts";
import type { TreeViewState } from "../main-thread/tree.ts";

interface TreeNode {
  id: string;
  label: string;
  description?: string;
  collapsibleState: number;
  resourceUri?: { path: string };
  command?: { command: string; arguments?: unknown[] };
  checkboxState?:
    | number
    | { state: number; tooltip?: string; accessibilityInformation?: { label: string } };
}

const extHost = inject(ExtensionHostClientService);
const commands = inject(UiCommandsService);

interface TreeContent {
  readonly view: TreeViewState;
  revision: number;
  readonly branches: Map<string | undefined, TreeNode[]>;
  readonly expansion: Map<string, boolean>;
  readonly pending: Map<string | undefined, symbol>;
  readonly errors: Map<string | undefined, string>;
  selectionAnchor?: string;
}

const contents = reactive(new Map<string, TreeContent>());
const sections = new Map<string, HTMLElement>();
function setSection(viewId: string, element: unknown) {
  if (element instanceof HTMLElement) sections.set(viewId, element);
  else sections.delete(viewId);
}

const viewList = computed(() => Array.from(extHost.treeViews.values()));
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuTarget = shallowRef<{ view: TreeViewState; context: { viewId: string; nodeId?: string } }>();
const menuGroups = computed(() => {
  const target = menuTarget.value;
  if (!target || extHost.treeViews.get(target.view.viewId) !== target.view) return [];
  const content = contents.get(target.context.viewId);
  if (!content) return [];
  const rows = visibleRows(content);
  const node = rows.find(({ node }) => node.id === target.context.nodeId)?.node;
  if (target.context.nodeId && !node) return [];
  const viewId = target.view.viewId;
  return extHost.treeMenu.resolve({
    viewId, node,
    expanded: !!node && isExpanded(content, node),
    canCollapse: rows.some(({ expanded }) => expanded),
    open: async () => {
      if (!node?.command) return;
      const selection = content.view.selection?.includes(node.id) ? content.view.selection : [node.id];
      if (!await extHost.setTreeSelection(viewId, selection)) return;
      if (extHost.treeViews.get(viewId) !== content.view) return;
      content.view.selection = selection;
      await commands.execute(node.command.command, ...(node.command.arguments ?? []));
    },
    toggle: () => { if (node) toggleNode(viewId, node); },
    refresh: () => loadBranch(content),
    collapseAll: () => {
      for (const { node } of rows) if (node.collapsibleState) content.expansion.set(node.id, false);
    },
  });
});

async function openMenu(view: TreeViewState, node: TreeNode | undefined, event: MouseEvent | KeyboardEvent) {
  if (event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const row = event.currentTarget;
  if (!(row instanceof HTMLElement)) return;
  menuTarget.value = { view, context: { viewId: view.viewId, nodeId: node?.id } };
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const anchor = row.querySelector<HTMLElement>(".ext-tree-row") ?? row;
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

onBeforeUnmount(() => contents.clear());

watch(
  () =>
    viewList.value.reduce<{ viewId: string; focusRevision: number } | undefined>(
      (latest, view) =>
        view.focusRevision > (latest?.focusRevision ?? 0)
          ? { viewId: view.viewId, focusRevision: view.focusRevision }
          : latest,
      undefined,
    ),
  async (view) => {
    if (!view?.focusRevision) return;
    await nextTick();
    sections.get(view.viewId)?.focus();
  },
  { immediate: true },
);

function isExpanded(content: TreeContent, node: TreeNode): boolean {
  return (
    node.collapsibleState > 0 && (content.expansion.get(node.id) ?? node.collapsibleState === 2)
  );
}

function clearBranch(content: TreeContent, parentId: string): void {
  const children = content.branches.get(parentId) ?? [];
  content.branches.delete(parentId);
  content.pending.delete(parentId);
  content.errors.delete(parentId);
  for (const child of children) {
    forgetNode(content, child.id);
  }
}

function forgetNode(content: TreeContent, id: string): void {
  content.expansion.delete(id);
  if (content.selectionAnchor === id) content.selectionAnchor = undefined;
  if (content.view.selection?.includes(id))
    content.view.selection = content.view.selection.filter((selected) => selected !== id);
  clearBranch(content, id);
}

async function loadBranch(content: TreeContent, parentId?: string): Promise<void> {
  const { viewId, revision } = content.view;
  const request = Symbol();
  content.pending.set(parentId, request);
  const current = () =>
    contents.get(viewId) === content &&
    extHost.treeViews.get(viewId) === content.view &&
    content.view.revision === revision &&
    content.pending.get(parentId) === request;
  try {
    const nodes = (await extHost.getTreeChildren(viewId, parentId)) as TreeNode[] | null;
    if (!nodes || !current()) return;
    const next = new Set(nodes.map((node) => node.id));
    for (const previous of content.branches.get(parentId) ?? []) {
      if (next.has(previous.id)) continue;
      forgetNode(content, previous.id);
    }
    content.branches.set(parentId, nodes);
    content.errors.delete(parentId);
    for (const node of nodes) {
      if (node.collapsibleState === 0) clearBranch(content, node.id);
      else if (isExpanded(content, node)) void loadBranch(content, node.id);
    }
  } catch (error) {
    if (current())
      content.errors.set(parentId, error instanceof Error ? error.message : String(error));
  } finally {
    if (current()) content.pending.delete(parentId);
  }
}

watch(
  () => viewList.value.map((view) => ({ view, revision: view.revision })),
  (views) => {
    for (const id of contents.keys()) if (!extHost.treeViews.has(id)) contents.delete(id);
    for (const { view, revision } of views) {
      let content = contents.get(view.viewId);
      if (content?.view !== view) {
        content = reactive<TreeContent>({
          view,
          revision,
          branches: new Map(),
          expansion: new Map(),
          pending: new Map(),
          errors: new Map(),
        });
        contents.set(view.viewId, content);
      } else if (content.revision === revision) {
        continue;
      }
      content.revision = revision;
      content.pending.clear();
      void loadBranch(content);
    }
  },
  { immediate: true },
);

function visibleRows(content: TreeContent | undefined) {
  const rows: { node: TreeNode; level: number; expanded: boolean }[] = [];
  if (!content) return rows;
  const visited = new Set<string>();
  function visit(tree: TreeContent, level: number, parentId?: string) {
    for (const node of tree.branches.get(parentId) ?? []) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const expanded = isExpanded(tree, node);
      rows.push({ node, level, expanded });
      if (expanded) visit(tree, level + 1, node.id);
    }
  }
  visit(content, 0);
  return rows;
}

const viewRows = computed(() =>
  viewList.value.map((view) => {
    const content = contents.get(view.viewId);
    return {
      view,
      rows: visibleRows(content),
      selected: new Set(view.selection),
      error: content?.errors.values().next().value,
    };
  }),
);

function selectRange(content: TreeContent, id: string, selection: readonly string[]): string[] {
  const ids = visibleRows(content).map(({ node }) => node.id);
  const target = ids.indexOf(id);
  const previousAnchor = content.selectionAnchor ?? selection.at(-1) ?? id;
  const anchor = ids.indexOf(previousAnchor);
  if (target < 0 || anchor < 0) return [id];
  content.selectionAnchor = previousAnchor;
  const previous = new Set([...selection, previousAnchor]);
  let first = anchor;
  let last = anchor;
  while (first > 0 && previous.has(ids[first - 1]!)) first--;
  while (last + 1 < ids.length && previous.has(ids[last + 1]!)) last++;
  const contiguous = new Set(ids.slice(first, last + 1));
  return [
    ...new Set([
      ...selection.filter((selected) => !contiguous.has(selected)),
      ...ids.slice(Math.min(anchor, target), Math.max(anchor, target) + 1),
    ]),
  ];
}

async function activateNode(viewId: string, node: TreeNode, event: MouseEvent) {
  const content = contents.get(viewId);
  if (!content) return;
  if (
    node.collapsibleState > 0 &&
    event.target instanceof Element &&
    event.target.closest(".ext-tree-twistie")
  ) {
    toggleNode(viewId, node);
    return;
  }
  const range = content.view.canSelectMany && event.shiftKey;
  const toggle =
    content.view.canSelectMany && (/Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey);
  const current = content.view.selection ?? [];
  const anchor = content.selectionAnchor;
  let next = [node.id];
  if (range) next = selectRange(content, node.id, current);
  else {
    content.selectionAnchor = node.id;
    if (toggle)
      next = current.includes(node.id)
        ? current.filter((id) => id !== node.id)
        : [...current, node.id];
  }
  content.view.selection = next;
  const requested = content.view.selection;
  let accepted = false;
  try {
    accepted = await extHost.setTreeSelection(viewId, next);
  } finally {
    if (!accepted && content.view.selection === requested) {
      content.view.selection = current;
      content.selectionAnchor = anchor;
    }
  }
  if (!accepted || range || toggle || extHost.treeViews.get(viewId) !== content.view) return;
  toggleNode(viewId, node);
}

function toggleNode(viewId: string, node: TreeNode) {
  if (node.collapsibleState > 0) {
    const content = contents.get(viewId);
    if (!content) return;
    const expanding = !isExpanded(content, node);
    content.expansion.set(node.id, expanding);
    if (expanding) void loadBranch(content, node.id);
    return;
  }
  if (node.command?.command) {
    void commands.execute(node.command.command, ...(node.command.arguments ?? []));
  }
}

function checkboxState(node: TreeNode): number | undefined {
  return typeof node.checkboxState === "object" ? node.checkboxState.state : node.checkboxState;
}
async function changeCheckbox(viewId: string, node: TreeNode, event: Event) {
  const state = (event.target as HTMLInputElement).checked ? 1 : 0;
  await extHost.setTreeCheckboxState(viewId, node.id, state);
  node.checkboxState =
    typeof node.checkboxState === "object" ? { ...node.checkboxState, state } : state;
}
</script>

<template>
  <div class="ext-tree-views">
    <div v-if="viewList.length === 0" class="ext-tree-empty">No extension tree views</div>
    <section
      v-for="{ view, rows, selected, error } in viewRows"
      :key="view.viewId"
      :ref="(element) => setSection(view.viewId, element)"
      class="ext-tree-section"
      @contextmenu="openMenu(view, undefined, $event)"
      @keydown="openMenu(view, undefined, $event)"
      :data-tree-view="view.viewId"
      tabindex="-1"
    >
      <ViewProgressSlot :view-id="view.viewId" />
      <div class="ext-tree-header">{{ view.viewId }}</div>
      <div v-if="error" role="alert">{{ error }}</div>
      <div
        role="tree"
        :aria-label="view.viewId"
        :aria-multiselectable="view.canSelectMany || undefined"
      >
        <div
          v-for="{ node, level, expanded } in rows"
          :key="node.id"
          class="ext-tree-node"
          @contextmenu="openMenu(view, node, $event)"
          @keydown="openMenu(view, node, $event)"
          role="treeitem"
          :aria-level="level + 1"
          :aria-expanded="node.collapsibleState > 0 ? expanded : undefined"
          :aria-selected="selected.has(node.id)"
          :class="{ selected: selected.has(node.id) }"
          :style="{ paddingInlineStart: `${level * 8}px` }"
        >
          <input
            v-if="checkboxState(node) !== undefined"
            type="checkbox"
            :checked="checkboxState(node) === 1"
            :aria-label="
              typeof node.checkboxState === 'object'
                ? (node.checkboxState.accessibilityInformation?.label ?? node.label)
                : node.label
            "
            @change="changeCheckbox(view.viewId, node, $event)"
          />
          <button
            type="button"
            class="ext-tree-row"
            :aria-expanded="node.collapsibleState > 0 ? expanded : undefined"
            @click="activateNode(view.viewId, node, $event)"
          >
            <span class="ext-tree-twistie" aria-hidden="true">{{
              node.collapsibleState > 0 ? (expanded ? "▾" : "▸") : "·"
            }}</span>
            <span class="ext-tree-label">{{ node.label }}</span>
            <span v-if="node.description" class="ext-tree-desc">{{ node.description }}</span>
          </button>
        </div>
      </div>
    </section>
    <ContextMenu ref="contextMenu" label="Tree item actions" :groups="menuGroups"
      :on-error="(error) => { if (menuTarget) contents.get(menuTarget.view.viewId)?.errors.set(undefined, String(error)); }" />
  </div>
</template>

<style scoped>
.ext-tree-views {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
}
.ext-tree-empty {
  opacity: 0.6;
  padding: 8px;
}
.ext-tree-section {
  position: relative;
}
.ext-tree-section > :deep(.extension-view-progress) {
  inset: 0 0 auto;
}
.ext-tree-header {
  font-weight: 600;
  padding: 4px 6px;
  text-transform: uppercase;
  font-size: 11px;
  opacity: 0.8;
}
.ext-tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  padding: 3px 6px;
  cursor: pointer;
}
.ext-tree-node {
  display: flex;
  align-items: center;
}
.ext-tree-row:hover {
  background: rgba(128, 128, 128, 0.14);
}
.ext-tree-node.selected {
  background: var(--vscode-list-inactiveSelectionBackground, rgba(128, 128, 128, 0.24));
  color: var(--vscode-list-inactiveSelectionForeground, inherit);
}
.ext-tree-section:focus-within .ext-tree-node.selected {
  background: var(--vscode-list-activeSelectionBackground, rgba(128, 128, 128, 0.32));
  color: var(--vscode-list-activeSelectionForeground, inherit);
}
.ext-tree-desc {
  opacity: 0.6;
  font-size: 11px;
}
</style>
