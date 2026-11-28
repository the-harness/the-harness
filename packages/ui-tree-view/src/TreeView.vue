<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: TreeView
  Adaptation: Standalone tree with a compact root gutter and 8px child indentation.
-->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, onBeforeUnmount } from "vue";
import { useTree } from "./useTree";
import type { TreeNode, TreeAction, ContextMenuAnchor } from "./types";
import TreeActions from "./TreeActions.vue";
import { isContextMenuKey } from "./internal/contextMenuKeyboard";
import { StandardWheelEvent, type IMouseWheelEvent } from "./internal/standardWheelEvent";

const props = withDefaults(
  defineProps<{
    nodes: readonly TreeNode[];
    ariaLabel?: string;
    height?: number;
    multiple?: boolean;
    expandOnLabel?: boolean;
    draggable?: boolean;
  }>(),
  { ariaLabel: "Tree", height: 264, multiple: true, expandOnLabel: false, draggable: false },
);
const expanded = defineModel<string[]>("expandedIds", { default: () => [] });
const selected = defineModel<string[]>("selectedIds", { default: () => [] });
defineSlots<{
  label?: (props: { node: TreeNode }) => unknown;
  actions?: (props: { node: TreeNode }) => unknown;
}>();
const emit = defineEmits<{
  focusChange: [id: string | undefined];
  contextmenu: [
    node: TreeNode | undefined,
    event: MouseEvent | KeyboardEvent,
    anchor?: ContextMenuAnchor,
  ];
  action: [action: TreeAction, node: TreeNode];
  drop: [payload: { sourceId: string; targetId: string; position: "before" | "after" | "inside" }];
}>();
const element = ref<HTMLElement>();
const viewport = ref<HTMLElement>();
const scrollTop = ref(0);
const hovering = ref(false);
const dragging = ref(false);
const scrolling = ref(false);
const draggingId = ref<string>();
const dropTarget = ref<{ id: string; position: "before" | "after" | "inside" }>();

function onRowDragStart(id: string, event: DragEvent) {
  if (!props.draggable) return;
  draggingId.value = id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }
}

function onRowDragOver(row: { node: TreeNode }, event: DragEvent) {
  if (!props.draggable || !draggingId.value || draggingId.value === row.node.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const y = event.clientY - rect.top;
  const ratio = y / rect.height;
  const isFolder = Boolean(row.node.children);
  const position: "before" | "after" | "inside" =
    isFolder && ratio > 0.25 && ratio < 0.75 ? "inside" : ratio < 0.5 ? "before" : "after";
  dropTarget.value = { id: row.node.id, position };
}

function onRowDrop(row: { node: TreeNode }, event: DragEvent) {
  if (!props.draggable) return;
  event.preventDefault();
  const sourceId = draggingId.value || event.dataTransfer?.getData("text/plain");
  const target = dropTarget.value;
  draggingId.value = undefined;
  dropTarget.value = undefined;
  if (!sourceId || !target || sourceId === row.node.id) return;
  emit("drop", { sourceId, targetId: row.node.id, position: target.position });
}

function onRowDragEnd() {
  draggingId.value = undefined;
  dropTarget.value = undefined;
}
let scrollTimer: ReturnType<typeof setTimeout>;
const instanceId = useId();
const rowId = (id: string) => `${instanceId}-${encodeURIComponent(id)}`;
function setScroll(top: number) {
  const bounded = Math.max(0, Math.min(totalHeight.value - props.height, top));
  scrollTop.value = bounded;
  if (viewport.value) viewport.value.scrollTop = bounded;
}
function reveal(index: number) {
  if (index < 0) return;
  const top = index * 22;
  if (top < scrollTop.value) setScroll(top);
  else if (top + 22 > scrollTop.value + props.height) setScroll(top + 22 - props.height);
}
const tree = useTree(props, expanded, selected, element, reveal, (id) => emit("focusChange", id));
const { rows, focused, activeGuides, expandedSet } = tree;
const hasBranches = computed(() => props.nodes.some((node) => Boolean(node.children?.length)));
const selectedSet = computed(() => new Set(selected.value));
const totalHeight = computed(() => rows.value.length * 22);
const first = computed(() => Math.max(0, Math.floor(scrollTop.value / 22) - 1));
const renderedRows = computed(() =>
  rows.value.slice(first.value, Math.ceil((scrollTop.value + props.height) / 22) + 1),
);
const hasScrollbar = computed(() => totalHeight.value > props.height);
const thumbHeight = computed(() =>
  Math.max(20, Math.floor((props.height * props.height) / totalHeight.value)),
);
const thumbRatio = computed(
  () => (props.height - thumbHeight.value) / (totalHeight.value - props.height),
);
const thumbTop = computed(() => Math.round(scrollTop.value * thumbRatio.value));
const activeDescendant = computed(() =>
  renderedRows.value.some((row) => row.node.id === focused.value)
    ? rowId(focused.value!)
    : undefined,
);
watch(totalHeight, () => nextTick(() => setScroll(scrollTop.value)));

let contextKeyDown = false;
function keyup(event: KeyboardEvent) {
  contextKeyDown = false;
  if (!isContextMenuKey(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const item = rows.value.find((row) => row.node.id === focused.value)?.node;
  const anchor = focused.value
    ? document.getElementById(rowId(focused.value)) || element.value
    : element.value;
  emit("contextmenu", item, event, anchor);
}
function contextmenu(event: MouseEvent) {
  if (contextKeyDown) return;
  const id = (event.target as HTMLElement).closest<HTMLElement>(".vc-tree-row")?.dataset.id;
  tree.focus(id);
  const item = rows.value.find((row) => row.node.id === focused.value)?.node;
  emit("contextmenu", item, event, event);
}
let focusingFromPointer = false;
function onMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const control = target.closest(
    "button, input, textarea, select, a[href], [contenteditable], [tabindex]",
  );
  if (control && control !== element.value) return;
  focusingFromPointer = true;
  element.value?.focus({ preventScroll: true });
  focusingFromPointer = false;
}
function focusInitialRow() {
  if (focusingFromPointer) return;
  if (rows.value.some((row) => row.node.id === focused.value)) {
    tree.focus(focused.value, true);
    return;
  }
  const selected = rows.value.find((row) => selectedSet.value.has(row.node.id));
  tree.focus(selected?.node.id ?? rows.value[0]?.node.id, true);
}
function keydown(event: KeyboardEvent) {
  contextKeyDown = isContextMenuKey(event);
  if (contextKeyDown) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    focused.value
  ) {
    const row = document.getElementById(rowId(focused.value));
    const action = row?.querySelector<HTMLElement>(".actions button:not(:disabled)");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      action.focus();
      return;
    }
  }
  tree.keydown(event, scrollTop.value, props.height, setScroll);
}

function scroll() {
  scrollTop.value = viewport.value?.scrollTop ?? 0;
  scrolling.value = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrolling.value = false;
  }, 500);
}
function wheel(event: WheelEvent) {
  const normalized = new StandardWheelEvent(event as unknown as IMouseWheelEvent);
  let deltaY = normalized.deltaY;
  if (Math.abs(normalized.deltaX) > Math.abs(deltaY)) deltaY = 0;
  if (!navigator.platform.includes("Mac") && event.shiftKey) deltaY = 0;
  if (event.altKey) deltaY *= 5;
  const delta = 50 * deltaY;
  const previous = scrollTop.value;
  setScroll(previous - (delta < 0 ? Math.floor(delta) : Math.ceil(delta)));
  // Consume wheel events whenever the content needs a scrollbar.
  if (hasScrollbar.value || previous !== scrollTop.value) {
    event.preventDefault();
    event.stopPropagation();
  }
}
function scrollbarDown(event: PointerEvent) {
  event.preventDefault();
  const track = event.currentTarget as HTMLElement;
  const onThumb = (event.target as HTMLElement).classList.contains("vc-tree-thumb");
  if (!onThumb)
    setScroll(
      (event.clientY - track.getBoundingClientRect().top - thumbHeight.value / 2) /
        thumbRatio.value,
    );
  const start = event.clientY,
    sliderPosition = thumbTop.value;
  dragging.value = true;
  track.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) =>
    setScroll(Math.round((sliderPosition + e.clientY - start) / thumbRatio.value));
  const up = () => {
    dragging.value = false;
    track.removeEventListener("pointermove", move);
    track.removeEventListener("pointerup", up);
    track.removeEventListener("lostpointercapture", up);
  };
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("lostpointercapture", up);
}
defineExpose({
  focus: (id?: string) => {
    if (id) tree.focus(id, true);
    element.value?.focus();
  },
  reveal: (id: string) => reveal(rows.value.findIndex((row) => row.node.id === id)),
  collapseAll: () => {
    expanded.value = [];
    selected.value = [];
    tree.focus();
  },
});
onBeforeUnmount(() => clearTimeout(scrollTimer));
</script>

<template>
  <div class="vc-tree-root">
    <div
      ref="element"
      class="vc-tree"
      :class="{ 'element-focused': focused }"
      role="tree"
      tabindex="0"
      :style="{ height: `${height}px` }"
      :aria-label="ariaLabel"
      :aria-multiselectable="multiple || undefined"
      :aria-activedescendant="activeDescendant"
      @focus="focusInitialRow"
      @mouseenter="hovering = true"
      @mouseleave="hovering = false"
      @keydown.self="keydown"
      @keyup.self="keyup"
      @contextmenu="contextmenu"
      @mousedown="onMouseDown"
      @wheel="wheel"
    >
      <div ref="viewport" class="vc-tree-viewport" @scroll="scroll" @click.self="tree.blank()">
        <div
          class="vc-tree-rows"
          :style="{ height: `${totalHeight}px` }"
          @click.self="tree.blank()"
        >
          <div
            v-for="(row, i) in renderedRows"
            :id="rowId(row.node.id)"
            :key="row.node.id"
            :data-id="row.node.id"
            class="vc-tree-row"
            :class="{
              focused: focused === row.node.id,
              selected: selectedSet.has(row.node.id),
              'drag-before': dropTarget?.id === row.node.id && dropTarget.position === 'before',
              'drag-after': dropTarget?.id === row.node.id && dropTarget.position === 'after',
              'drag-inside': dropTarget?.id === row.node.id && dropTarget.position === 'inside',
            }"
            :style="{
              top: `${(first + i) * 22}px`,
              height: '22px',
              lineHeight: '22px',
            }"
            role="treeitem"
            :aria-label="
              [
                row.node.label,
                row.node.decoration?.tooltip,
                row.node.actions?.length ? 'has actions' : undefined,
              ]
                .filter(Boolean)
                .join(', ')
            "
            :aria-level="row.depth"
            :aria-posinset="row.position"
            :aria-setsize="row.setSize"
            :aria-selected="selectedSet.has(row.node.id)"
            :aria-expanded="row.node.children?.length ? expandedSet.has(row.node.id) : undefined"
            :draggable="props.draggable"
            @dragstart="onRowDragStart(row.node.id, $event)"
            @dragover="onRowDragOver(row, $event)"
            @drop="onRowDrop(row, $event)"
            @dragend="onRowDragEnd"
            @click="
              tree.click(
                row,
                $event,
                ($event.target as HTMLElement).closest('.vc-tree-twistie') !== null,
              )
            "
          >
            <div class="vc-tree-row-inner">
              <div
                class="vc-tree-indent"
                :style="{ width: `${(row.depth - 1) * 8}px` }"
                aria-hidden="true"
              >
                <div
                  v-for="ancestor in row.ancestors"
                  :key="ancestor"
                  class="vc-tree-indent-guide"
                  style="width: 8px"
                  :class="{ active: activeGuides.has(ancestor) }"
                />
              </div>
              <div
                v-if="hasBranches"
                class="vc-tree-twistie"
                :class="{
                  collapsed: !expandedSet.has(row.node.id),
                }"
                :style="{ paddingLeft: `${(row.depth - 1) * 8}px` }"
                aria-hidden="true"
              >
                <span
                  v-if="row.node.children?.length"
                  class="i-codicon-chevron-down vc-twistie-icon"
                />
              </div>
              <div v-else style="width: 8px; flex-shrink: 0" aria-hidden="true" />
              <div class="vc-tree-contents">
                <div
                  class="vc-tree-label-container vc-tree-resource"
                  :class="{ strikethrough: row.node.decoration?.strikethrough }"
                  :data-decoration="row.node.decoration?.badge"
                  :title="row.node.decoration?.tooltip"
                  :style="
                    row.node.decoration?.color
                      ? { '--vc-decoration-color': row.node.decoration.color }
                      : undefined
                  "
                >
                  <span
                    class="vc-tree-node-icon"
                    :class="
                      row.node.icon?.startsWith('i-')
                        ? row.node.icon
                        : `i-codicon-${row.node.icon || (row.node.children ? 'folder' : 'file')}`
                    "
                    aria-hidden="true"
                  />
                  <slot name="label" :node="row.node">
                    <a class="vc-tree-label">{{ row.node.label }}</a>
                  </slot>
                  <span v-if="row.node.description" class="vc-tree-description">{{
                    row.node.description
                  }}</span>
                  <div
                    v-if="$slots.actions && row.node.actions?.length"
                    class="actions"
                    @pointerdown.stop
                    @mousedown.stop
                    @keydown.stop
                  >
                    <slot name="actions" :node="row.node" />
                  </div>
                  <TreeActions
                    v-else-if="row.node.actions?.length"
                    :actions="row.node.actions"
                    :label="row.node.label"
                    @action="emit('action', $event, row.node)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="hasScrollbar"
        class="vc-tree-scrollbar"
        :class="{ visible: hovering || dragging || scrolling }"
        @pointerdown="scrollbarDown"
      >
        <div
          class="vc-tree-thumb"
          :class="{ active: dragging }"
          :style="{ height: `${thumbHeight}px`, top: `${thumbTop}px` }"
        />
      </div>
      <div v-if="scrollTop > 0" class="vc-tree-shadow" />
      <div v-if="scrollTop > 0" class="vc-tree-shadow vc-tree-shadow-corner" />
    </div>
  </div>
</template>

<style src="./tree.css" />
<style src="./tree.css" />
