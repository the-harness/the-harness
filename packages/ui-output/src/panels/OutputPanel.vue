<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: SelectBox, ActionBar. Adaptation: Native grouped channel picker and a clear action in the Output toolbar. -->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from "vue";
import { useService } from "@harness/ui-di";
import { ContextMenu } from "@harness/ui-menu";
import { UiOutputService, type OutputChannel, type OutputChannelGroup, type OutputMenuContext } from "@harness/ui-output";

const output = useService(UiOutputService);
const activeId = output.activeChannelId;
const log = ref<HTMLElement>();
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const context = shallowRef<OutputMenuContext>();
const menuGroups = computed(() => {
  const target = context.value;
  if (!target || !output.channels.value.some((channel) => channel.id === target.channelId)) return [];
  return output.menu.resolve(target);
});

async function openMenu(event: MouseEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent &&
    (event.isComposing || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))) return;
  const element = log.value;
  const channelId = activeId.value;
  if (!element || !channelId) return;
  const selection = window.getSelection();
  context.value = {
    channelId,
    selection: selection?.anchorNode && element.contains(selection.anchorNode) ? selection.toString() : "",
    selectAll: () => {
      if (!element.isConnected) return;
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.focus();
    },
  };
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : element, element);
}

const activeChannel = computed(() =>
  output.channels.value.find((channel) => channel.id === activeId.value),
);
const channelGroups = computed(() => {
  const groups = new Map<
    string | undefined,
    {
      workspace?: OutputChannelGroup;
      channels: OutputChannel[];
    }
  >();
  for (const channel of output.channels.value) {
    const workspace = channel.group;
    const group = groups.get(workspace?.id);
    if (group) group.channels.push(channel);
    else groups.set(workspace?.id, { workspace, channels: [channel] });
  }
  return [...groups.values()];
});

function groupLabel(workspace: OutputChannelGroup | undefined): string {
  if (!workspace) return "Other";
  return workspace.detail ? `${workspace.label} — ${workspace.detail}` : workspace.label;
}
</script>

<template>
  <section class="panel-fill output-panel">
    <div class="output-toolbar">
      <span
        v-if="activeChannel?.group"
        class="output-workspace"
        :title="groupLabel(activeChannel.group)"
      >
        {{ activeChannel.group.label }}
      </span>
      <select v-model="activeId" :disabled="!channelGroups.length" aria-label="Output Channel">
        <option v-if="!channelGroups.length" :value="null">No output channels</option>
        <optgroup
          v-for="{ workspace, channels } in channelGroups"
          :key="workspace?.id"
          :label="groupLabel(workspace)"
        >
          <option v-for="channel in channels" :key="channel.id" :value="channel.id">
            {{ channel.name }}
          </option>
        </optgroup>
      </select>
      <button
        type="button"
        class="output-clear"
        title="Clear Output"
        aria-label="Clear Output"
        :disabled="!activeChannel"
        @click="activeChannel?.clear()"
      >
        <span class="i-codicon-clear-all" aria-hidden="true" />
      </button>
    </div>
    <pre ref="log" class="output-log" tabindex="0" aria-label="Output content"
      @contextmenu="openMenu" @keydown="openMenu">{{ activeChannel?.lines.join("\n") ?? "" }}</pre>
    <ContextMenu ref="contextMenu" label="Output actions" :groups="menuGroups" />
  </section>
</template>

<style scoped>
.output-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.output-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
}

.output-workspace {
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output-toolbar select {
  min-width: 0;
  max-width: 100%;
  min-height: 22px;
  padding: 1px 6px;
  border: 1px solid var(--control-border);
  border-radius: 2px;
  background: var(--input);
  color: var(--fg);
  font-size: 12px;
}

.output-clear {
  display: grid;
  flex: none;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 4px;
  color: var(--strong);
}

.output-clear:not(:disabled):hover {
  background: var(--hover);
}

.output-toolbar :is(select, button):focus-visible {
  outline: 1px solid var(--selection-border);
}

.output-toolbar :disabled {
  opacity: 0.6;
}

.output-clear span {
  width: 16px;
  height: 16px;
}

.output-log {
  flex: 1;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
}
</style>
