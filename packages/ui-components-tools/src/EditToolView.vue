<script setup lang="ts">
import { computed, type Component } from "vue";
import { IconButton } from "@harness/ui-components-base";
import ToolDisclosure from "./ToolDisclosure.vue";

export interface DiffLine {
  readonly kind?: "ctx" | "add" | "del";
  readonly type?: "ctx" | "add" | "del";
  readonly text: string;
}

function lineKind(line: DiffLine): "ctx" | "add" | "del" {
  return line.kind ?? line.type ?? "ctx";
}

const props = withDefaults(
  defineProps<{
    mode?: "edit" | "write";
    label?: string;
    path?: string;
    diff?: readonly DiffLine[];
    added?: number;
    removed?: number;
    content?: string;
    lang?: string;
    status?: "running" | "ok" | "error";
    codeBlock?: Component<{ code: string; lang?: string; framed?: boolean }>;
  }>(),
  {
    mode: "edit",
    status: "ok",
  },
);

const emit = defineEmits<{
  openFile: [path: string];
  copy: [text?: string];
}>();

const resolvedLabel = computed(() => props.label ?? (props.mode === "write" ? "Write" : "Edit"));
const resolvedIcon = computed(() =>
  props.mode === "write" ? "i-codicon-new-file" : "i-codicon-edit",
);
const baseName = computed(() => (props.path ? props.path.split("/").pop() || props.path : ""));
const dirName = computed(() => {
  if (!props.path) return "";
  const idx = props.path.lastIndexOf("/");
  return idx > 0 ? props.path.slice(0, idx) : "";
});
const diffText = computed(() =>
  (props.diff ?? [])
    .map((line) => {
      const k = lineKind(line);
      return `${k === "add" ? "+" : k === "del" ? "-" : " "}${line.text}`;
    })
    .join("\n"),
);
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
    :icon="resolvedIcon"
    :name="resolvedLabel"
    :status="status"
    :expandable="Boolean(diff?.length || content)"
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
    <span v-if="added" class="tl-add">+{{ added }}</span>
    <span v-if="removed" class="tl-del">−{{ removed }}</span>
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
          <span v-if="added" class="tl-add">+{{ added }}</span>
          <span v-if="removed" class="tl-del">−{{ removed }}</span>
          <IconButton
            icon="i-codicon-copy"
            label="Copy diff"
            @click.stop="emit('copy', diffText || content)"
          />
        </div>
        <div v-if="diff?.length" class="tool-diff">
          <div v-for="(line, index) in diff" :key="index" class="td-line" :class="lineKind(line)">
            <span class="td-sign">{{
              lineKind(line) === "add" ? "+" : lineKind(line) === "del" ? "−" : " "
            }}</span>
            <span class="td-code">{{ line.text }}</span>
          </div>
        </div>
        <component
          :is="codeBlock"
          v-else-if="content && codeBlock"
          :code="content"
          :lang="resolvedLang"
          :framed="false"
        />
        <pre v-else-if="content" class="tool-output">{{ content }}</pre>
      </div>
    </template>
  </ToolDisclosure>
</template>
