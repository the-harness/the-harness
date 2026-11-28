<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: EditorTabs, CompositeBar, IconLabel, IconButton. Adaptation: editor icons and close actions, or plain view labels, preserving Dockview's native dragging. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, nextTick, ref, watchEffect } from "vue";
import type { IDockviewPanelHeaderProps } from "dockview-vue";
import { IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";

const props = defineProps<{ params: IDockviewPanelHeaderProps }>();
const workbench = useService(UiWorkbenchService);
const tabs = useService(UiTabsService);
const panel = computed(() => workbench.panels().find((panel) => panel.id === props.params.api.id));
const tabInstance = computed(() => tabs.get(props.params.api.id));
const tabRenderer = computed(() =>
  tabInstance.value ? tabs.getRenderer(tabInstance.value.descriptor) : undefined,
);
const tabIcon = computed(() => {
  if (panel.value?.icon) return panel.value.icon;
  const icon = tabRenderer.value?.icon;
  if (typeof icon === "function" && tabInstance.value) {
    return icon(tabInstance.value.descriptor);
  }
  if (typeof icon === "string") return icon;
  return "i-codicon-layout";
});
const title = ref(props.params.api.title);
watchEffect((onCleanup) => {
  title.value = tabInstance.value?.title ?? props.params.api.title;
  const subscription = props.params.api.onDidTitleChange((event) => {
    title.value = event.title;
  });
  onCleanup(() => subscription.dispose());
});
async function closeTab() {
  const previous = document.activeElement;
  const dockRoot = props.params.api.group.element.closest(".dv-dockview");
  props.params.api.close();
  await nextTick();
  if (!previous || previous.isConnected || document.activeElement !== document.body) return;
  const group = props.params.containerApi.activePanel?.group;
  const content = group?.api.isVisible
    ? group.element.querySelector<HTMLElement>(".dv-content-container")
    : undefined;
  const input = [
    ...(content?.querySelectorAll<HTMLElement>(
      'textarea, input:not([type="hidden"]), [contenteditable="true"]',
    ) ?? []),
  ].find((element) => element.getClientRects().length && !element.closest("[inert]"));
  (
    input ??
    content ??
    dockRoot?.querySelector<HTMLElement>(".dv-watermark-container button")
  )?.focus();
}

function middleClose(event: MouseEvent) {
  if (event.button !== 1 || panel.value?.presentation === "view") return;
  event.preventDefault();
  event.stopPropagation();
  void closeTab();
}
</script>

<template>
  <div class="workbench-tab" :data-tab-id="params.api.id" :title="title" @auxclick="middleClose">
    <span
      v-if="panel?.presentation !== 'view'"
      class="workbench-tab-icon"
      :class="tabIcon"
      aria-hidden="true"
    />
    <span class="workbench-tab-title">{{ title }}</span>
    <IconButton
      v-if="panel?.presentation !== 'view'"
      icon="i-codicon-close"
      :label="`Close ${title}`"
      @pointerdown.stop
      @mousedown.stop
      @keydown.stop
      @dblclick.stop
      @click.stop="closeTab"
    />
  </div>
</template>
