<script setup lang="ts">
import { computed, type Component } from "vue";
import { IconButton } from "@harness/ui-components-base";
import ToolDisclosure from "./ToolDisclosure.vue";

const props = withDefaults(
  defineProps<{
    label?: string;
    path?: string;
    range?: string;
    content?: string;
    lang?: string;
    status?: "running" | "ok" | "error";
    codeBlock?: Component<{ code: string; lang?: string; framed?: boolean }>;
  }>(),
  {
    label: "Read",
    status: "ok",
  },
);

const emit = defineEmits<{
  openFile: [path: string];
  copy: [text?: string];
}>();

const baseName = computed(() => (props.path ? props.path.split("/").pop() || props.path : ""));
const dirName = computed(() => {
  if (!props.path) return "";
  const idx = props.path.lastIndexOf("/");
  return idx > 0 ? props.path.slice(0, idx) : "";
});
const resolvedLang = computed(() => {
  if (props.lang) return props.lang;
  const ext = props.path?.split(".").pop()?.toLowerCase();
  if (!ext) return "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    vue: "vue",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? ext;
});
</script>

<template>
  <ToolDisclosure
    icon="i-codicon-file-code"
    :name="label"
    :status="status"
    :expandable="Boolean(content)"
  >
    <button
      v-if="path"
      type="button"
      class="tl-file"
      :title="path"
      @click.stop="emit('openFile', path)"
    >
      {{ baseName }}
    </button>
    <span v-if="range" class="tl-dim">{{ range }}</span>
    <template #body>
      <div class="tool-panel">
        <div class="tool-panel-head">
          <span class="tool-panel-path">
            <span v-if="dirName" class="tl-dim">{{ dirName }}/</span>
            <button v-if="path" type="button" class="tl-file" @click="emit('openFile', path)">
              {{ baseName }}
            </button>
          </span>
          <span class="spacer" />
          <IconButton
            icon="i-codicon-copy"
            label="Copy file content"
            @click.stop="emit('copy', content)"
          />
        </div>
        <component
          :is="codeBlock"
          v-if="codeBlock"
          :code="content ?? ''"
          :lang="resolvedLang"
          :framed="false"
        />
        <pre v-else class="tool-output">{{ content ?? "" }}</pre>
      </div>
    </template>
  </ToolDisclosure>
</template>
