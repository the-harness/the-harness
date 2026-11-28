<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Pane. Adaptation: compact disclosure for consecutive tools and thoughts, inspired by OpenCode's context tool group. -->
<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { ActivityItem } from "../types.ts";

const props = withDefaults(
  defineProps<{
    items: readonly ActivityItem[];
    streaming?: boolean;
    duration?: string;
  }>(),
  { streaming: false },
);

const isRunning = computed(
  () =>
    props.streaming ||
    props.items.some(
      (item) =>
        (item.kind === "thinking" && item.streaming) ||
        (item.kind === "tool" && item.tool.status === "running"),
    ),
);

const open = ref(isRunning.value);
const bodyId = useId();
let userInteracted = false;
watch(isRunning, (now, prev) => {
  if (now) {
    userInteracted = false;
    open.value = true;
  } else if (prev && !userInteracted) open.value = false;
});

const tools = computed(() => props.items.filter((item) => item.kind === "tool"));
const singleThought = computed(() => {
  const item = props.items[0];
  return props.items.length === 1 && item?.kind === "thinking"
    ? { ...item, duration: item.duration ?? props.duration }
    : undefined;
});
const summary = computed(() => {
  const toolCount = tools.value.length;
  const toolLabel = `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  const hasThought = props.items.some((item) => item.kind === "thinking");
  const errors = tools.value.filter((item) => item.tool.status === "error").length;
  const action = toolCount
    ? `${hasThought ? "Thought and called" : "Called"} ${toolLabel}`
    : "Thought";
  const elapsed = props.duration ? ` ${toolCount ? "in" : "for"} ${props.duration}` : "";
  const label = isRunning.value
    ? (toolCount ? `Calling ${toolLabel}…` : "Thinking…")
    : action + elapsed;
  return [
    label,
    errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
});
</script>

<template>
  <div
    v-if="items.length > 0"
    class="activity-run"
    :class="{ open: !singleThought && open, running: isRunning, single: !!singleThought }"
    @pointerdown.capture="userInteracted = true"
    @keydown.capture="userInteracted = true"
  >
    <button
      v-if="!singleThought"
      type="button"
      class="ar-head"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="open = !open"
    >
      <span class="ar-sum" :title="summary">{{ summary }}</span>
      <span class="i-codicon-chevron-right ar-car" aria-hidden="true" />
    </button>
    <div
      :id="bodyId"
      class="ar-body"
      :class="{ open: singleThought || open }"
      :inert="!singleThought && !open"
    >
      <div class="ar-body-inner">
        <template v-for="item in singleThought ? [singleThought] : items" :key="item.id">
          <slot :item="item" />
        </template>
      </div>
    </div>
  </div>
</template>
