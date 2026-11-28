<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Pane. Adaptation: compact tool disclosure with independently operable file actions. -->
<script setup lang="ts">
import { ref, useId } from "vue";

const props = withDefaults(
  defineProps<{
    icon?: string;
    name: string;
    status?: "running" | "ok" | "error";
    expandable?: boolean;
    defaultOpen?: boolean;
  }>(),
  {
    icon: "i-codicon-tools",
    status: "ok",
    expandable: false,
    defaultOpen: false,
  },
);

const open = ref(props.defaultOpen);
const bodyId = useId();
function toggle() {
  if (!props.expandable) return;
  open.value = !open.value;
}
</script>

<template>
  <div class="tool-line" :class="{ open, expandable, err: status === 'error' }">
    <div
      class="tl-head"
      :class="{ clickable: expandable }"
      :role="expandable ? 'button' : undefined"
      :tabindex="expandable ? 0 : undefined"
      :aria-expanded="expandable ? open : undefined"
      :aria-controls="expandable ? bodyId : undefined"
      @click="toggle"
      @keydown.enter.self.prevent="toggle"
      @keydown.space.self.prevent="toggle"
    >
      <span class="tl-ic" aria-hidden="true"><span :class="icon" /></span>
      <span class="tl-main">
        <span class="tl-lead">
          <span class="tl-name">{{ name }}</span>
          <slot />
          <span v-if="expandable" class="i-codicon-chevron-right tl-car-ic" aria-hidden="true" />
        </span>
        <span class="tl-tail">
          <slot name="trailing" />
          <span v-if="status === 'running'" class="tl-dot running" aria-label="Running" />
          <span
            v-else-if="status === 'error'"
            class="i-codicon-error text-[var(--red)] text-xs"
            aria-label="Error"
          />
        </span>
      </span>
    </div>
    <div v-if="expandable" :id="bodyId" class="tl-body" :class="{ open }" :inert="!open">
      <div class="tl-body-inner">
        <div class="tl-body-content">
          <slot name="body" />
        </div>
      </div>
    </div>
  </div>
</template>
