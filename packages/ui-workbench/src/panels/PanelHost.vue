<script setup lang="ts">
import { computed } from "vue";
import type { IDockviewPanelProps } from "dockview-vue";
import { provideScope, useService } from "@harness/ui-di";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";

const props = defineProps<{ params: IDockviewPanelProps }>();
const workbench = useService(UiWorkbenchService);
const tabs = useService(UiTabsService);

const tabId = computed(() => props.params.params.tabId as string | undefined);
const tab = computed(() => (tabId.value ? tabs.get(tabId.value) : undefined));

if (tab.value) {
  provideScope(tab.value.scope);
}

const tabRenderer = computed(() =>
  tab.value ? tabs.getRenderer(tab.value.descriptor) : undefined,
);
const panel = computed(() =>
  workbench.panels().find((panel) => panel.id === props.params.params.panelId),
);
</script>
<template>
  <component :is="tabRenderer.component" v-if="tabRenderer" />
  <component :is="panel.component" v-else-if="panel" />
</template>
