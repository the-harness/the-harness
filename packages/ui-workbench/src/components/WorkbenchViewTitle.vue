<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: SidebarTitle, CompositeBar, Toolbar. Adaptation: View headings and compact view switching above Dockview's native drag surface. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed } from "vue";
import { RovingFocusGroup, RovingFocusItem } from "reka-ui";
import type { IDockviewHeaderActionsProps } from "dockview-vue";
import { IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiTabsService, UiWorkbenchService, ViewProgressSlot } from "@harness/ui-workbench";

const props = defineProps<{
  params: IDockviewHeaderActionsProps;
  side?: "prefix" | "right";
}>();
const workbench = useService(UiWorkbenchService);
const tabs = useService(UiTabsService);
const sidebarLocation = workbench.sidebarLocation;
const views = computed(() =>
  props.params.panels.map((panel) =>
    workbench.panels().find((definition) => definition.id === panel.id),
  ),
);
const isViewGroup = computed(
  () => views.value.length > 0 && views.value.every((view) => view?.presentation === "view"),
);
const isPrimarySidebar = computed(
  () => isViewGroup.value && views.value.every((view) => view?.location === "left"),
);
const activeView = computed(() =>
  views.value.find((view) => view?.id === props.params.activePanel?.id),
);
const activeTab = computed(() =>
  props.params.activePanel ? tabs.get(props.params.activePanel.id) : undefined,
);
const activeTabRenderer = computed(() =>
  activeTab.value ? tabs.getRenderer(activeTab.value.descriptor) : undefined,
);
const editorTitleActions = computed(
  () => activeTabRenderer.value?.titleActions ?? activeView.value?.titleActions ?? [],
);
</script>

<template>
  <template v-if="isViewGroup">
    <slot v-if="side !== 'right' && isPrimarySidebar" name="activityBar" />
    <div v-if="side === 'right'" class="workbench-view-actions">
      <RovingFocusGroup
        v-if="views.length > 1 && activeView?.titleActions?.length"
        orientation="horizontal"
        class="view-title-actions"
        role="toolbar"
        :aria-label="`${activeView.title} actions`"
        @pointerdown.stop
        @mousedown.stop
        @dblclick.stop
        @keydown.stop
      >
        <RovingFocusItem v-for="action in activeView.titleActions" :key="action.id" as-child
          ><IconButton
            :icon="action.icon"
            :label="action.title"
            :active="action.isActive?.()"
            :aria-pressed="action.isActive?.()"
            @click.stop="action.run()"
        /></RovingFocusItem>
      </RovingFocusGroup>
    </div>
    <div
      v-else
      class="workbench-view-header"
      :data-view-id="activeView?.id"
      :data-primary-sidebar="isPrimarySidebar ? sidebarLocation : undefined"
    >
      <h2 v-if="views.length === 1" class="workbench-view-title">{{ activeView?.title }}</h2>
      <ViewProgressSlot v-if="activeView" :view-id="activeView.id" />
      <RovingFocusGroup
        v-if="views.length === 1 && activeView?.titleActions?.length"
        orientation="horizontal"
        class="view-title-actions"
        role="toolbar"
        :aria-label="`${activeView.title} actions`"
        @pointerdown.stop
        @mousedown.stop
        @dblclick.stop
        @keydown.stop
      >
        <RovingFocusItem v-for="action in activeView.titleActions" :key="action.id" as-child
          ><IconButton
            :icon="action.icon"
            :label="action.title"
            :active="action.isActive?.()"
            :aria-pressed="action.isActive?.()"
            @click.stop="action.run()"
        /></RovingFocusItem>
      </RovingFocusGroup>
    </div>
  </template>
  <div v-else-if="side === 'right' && editorTitleActions.length" class="workbench-view-actions">
    <RovingFocusGroup
      orientation="horizontal"
      class="view-title-actions"
      role="toolbar"
      :aria-label="`${activeTab?.title ?? activeView?.title ?? 'Editor'} actions`"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @keydown.stop
    >
      <RovingFocusItem v-for="action in editorTitleActions" :key="action.id" as-child
        ><IconButton
          :icon="action.icon"
          :label="action.title"
          :active="action.isActive?.()"
          :aria-pressed="action.isActive?.()"
          @click.stop="action.run()"
      /></RovingFocusItem>
    </RovingFocusGroup>
  </div>
</template>
