<script setup lang="ts">
import { computed } from "vue";
import { useService } from "@harness/ui-di";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { MarkdownView } from "@harness/ui-chat";

const workspace = useService(UiWorkspaceService);
const selectedFile = workspace.selectedFile;

const markdown = computed(
  () => "```" + selectedFile.value.language + "\n" + selectedFile.value.content + "\n```",
);
</script>
<template>
  <section class="panel-fill preview-panel">
    <div class="view-toolbar">
      <span class="i-codicon-file-code" /><span class="truncate">{{ selectedFile.path }}</span>
    </div>
    <div class="flex-1 overflow-auto code-preview"><MarkdownView :text="markdown" /></div>
    <div class="panel-note">
      Read-only example <span class="spacer" />{{ selectedFile.language }} · UTF-8
    </div>
  </section>
</template>
