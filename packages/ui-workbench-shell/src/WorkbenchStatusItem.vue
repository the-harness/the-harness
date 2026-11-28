<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: StatusBar, StatusBarEntry, StatusBarTooltip. Adaptation: Native buttons for commands, Monaco codicons, and Reka tooltips. -->
<script setup lang="ts">
import type { StatusBarItem } from "@harness/ui-status-bar";
import { MarkdownRender } from "markstream-vue";
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
import { computed } from "vue";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";

const props = defineProps<{ item: StatusBarItem; dark: boolean }>();
const emit = defineEmits<{ activate: [command: string] }>();

const label = computed(() => {
  const text = props.item.text;
  const parts: ({ text: string } | { icon: string; spin: boolean })[] = [];
  let start = 0;
  for (const match of text.matchAll(/(?<!\\)\$\(([a-z0-9-]+)(~spin)?\)/gi)) {
    if (match.index > start) {
      parts.push({ text: text.slice(start, match.index).replaceAll("\\$(", "$(") });
    }
    parts.push({ icon: match[1]!, spin: !!match[2] });
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push({ text: text.slice(start).replaceAll("\\$(", "$(") });
  return parts;
});

const appearance = computed(() => {
  const { background, color } = props.item;
  if (background) {
    return {
      backgroundColor: `var(--vscode-statusBarItem-${background}Background, var(--${background}-bg))`,
      color: `var(--vscode-statusBarItem-${background}Foreground, var(--${background}-fg))`,
    };
  }
  return { color };
});

const ariaLabel = computed(() => {
  const text = label.value
    .flatMap((part) => ("text" in part ? part.text : []))
    .join("")
    .trim();
  return props.item.accessibilityInformation?.label ?? (text || props.item.name);
});
</script>

<template>
  <TooltipRoot v-if="item.text" :disabled="!item.tooltip">
    <TooltipTrigger as-child>
      <component
        :is="item.command ? 'button' : 'span'"
        :type="item.command ? 'button' : undefined"
        class="statusbar-item"
        :class="{ 'statusbar-passive': !item.command }"
        :tabindex="!item.command && item.tooltip ? 0 : undefined"
        :aria-label="ariaLabel"
        :role="item.accessibilityInformation?.role"
        :style="appearance"
        @click="item.command && emit('activate', item.command)"
      >
        <template v-for="(part, index) in label" :key="index">
          <span
            v-if="'icon' in part"
            class="codicon"
            :class="[`codicon-${part.icon}`, { 'codicon-modifier-spin': part.spin }]"
            aria-hidden="true"
          />
          <span v-else>{{ part.text }}</span>
        </template>
      </component>
    </TooltipTrigger>
    <TooltipPortal v-if="item.tooltip">
      <TooltipContent class="workbench-status-tooltip" side="top" :side-offset="6">
        <span v-if="typeof item.tooltip === 'string'">{{ item.tooltip }}</span>
        <MarkdownRender
          v-else
          :content="item.tooltip.markdown"
          :is-dark="dark"
          :final="true"
          :node-virtual="false"
          :show-tooltips="false"
          html-policy="escape"
          render-code-blocks-as-pre
        />
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>

<style scoped>
.statusbar-item {
  white-space: pre;
}

.statusbar-passive {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
}

.workbench-status-tooltip {
  z-index: 2600;
  max-width: min(360px, calc(100vw - 24px));
  padding: 6px 8px;
  background: var(--raised);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 12px var(--shadow);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
