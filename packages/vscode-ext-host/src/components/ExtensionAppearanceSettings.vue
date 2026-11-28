<!--
UI reference skill: vscode-ui
Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
Reference components: SelectBox
Adaptation: Existing native SelectBox controls for contributed appearance choices and persisted selection.
-->
<script setup lang="ts">
import { computed } from "vue";
import { SelectBox } from "@harness/ui-components-base";
import { VscodeConfigAdapter } from "../vscode-config.ts";
import { UiConfigService } from "@harness/ui-config";
import { useService } from "@harness/ui-di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";

const config = new VscodeConfigAdapter(useService(UiConfigService));
const workbench = useService(UiWorkbenchService);
const themes = computed(() => activeContributions.value?.availableThemes ?? []);
const icons = computed(() => activeContributions.value?.availableIconThemes ?? []);
const themeOptions = computed(() => [
  { label: "Default", value: "" },
  ...themes.value.map((theme) => ({ label: theme.label, value: theme.id })),
]);
const iconOptions = computed(() =>
  icons.value.map((theme) => ({ label: theme.label, value: theme.id })),
);
const theme = computed({
  get: () => config.get<string>("workbench.colorTheme", "") ?? "",
  set: (id: string) => {
    config.set("workbench.colorTheme", id || undefined);
    const selected = themes.value.find((theme) => theme.id === id);
    if (selected)
      workbench.theme.value =
        selected.uiTheme === "vs" || selected.uiTheme === "hc-light" ? "light" : "dark";
  },
});
const iconTheme = computed({
  get: () => config.get<string>("workbench.iconTheme", "vs-seti") ?? "vs-seti",
  set: (id: string) => config.set("workbench.iconTheme", id),
});
</script>

<template>
  <label v-if="themes.length" class="setting">
    <strong>Color theme</strong>
    <span>Choose your workbench appearance.</span>
    <SelectBox v-model="theme" :options="themeOptions" aria-label="Color theme" />
  </label>
  <slot v-else />
  <label v-if="icons.length" class="setting">
    <strong>File icon theme</strong>
    <span>Choose icons for files and folders.</span>
    <SelectBox v-model="iconTheme" :options="iconOptions" aria-label="File icon theme" />
  </label>
</template>
