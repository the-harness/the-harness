<script setup lang="ts">
import { useOptionalService } from "@harness/ui-di";
import { ProgressLocation } from "@harness/vscode-types";
import { computed } from "vue";
import { ExtensionHostClientService } from "../client.ts";
import ExtensionProgressBar from "./ExtensionProgressBar.vue";

const props = defineProps<{ viewId: string }>();
const host = useOptionalService(ExtensionHostClientService);
const progress = computed(() => {
  if (!host) return undefined;
  return [...host.progressEntries.values()].findLast(({ location }) =>
    typeof location === "object"
      ? location.viewId === props.viewId
      : location === ProgressLocation.SourceControl && props.viewId === "changes",
  );
});
</script>

<template>
  <ExtensionProgressBar
    v-if="progress"
    class="extension-view-progress"
    :label="progress.title"
    :value="progress.worked"
  />
  <slot />
</template>

<style scoped>
.extension-view-progress {
  position: absolute;
  inset: auto 0 0;
  pointer-events: none;
}
</style>
