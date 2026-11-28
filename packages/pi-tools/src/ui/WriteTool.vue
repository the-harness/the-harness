<script setup lang="ts">
import type { Component } from "vue";
import { EditToolView, type DiffLine } from "@harness/ui-components-tools";

defineProps<{
  tool: {
    status: "running" | "ok" | "error";
    target?: string;
    diff?: readonly DiffLine[];
    added?: number;
    removed?: number;
    output?: string;
  };
  codeBlock?: Component<{ code: string; lang?: string; framed?: boolean }>;
}>();

const emit = defineEmits<{
  openFile: [path: string];
  copy: [text?: string];
}>();
</script>

<template>
  <EditToolView
    mode="write"
    :path="tool.target"
    :diff="tool.diff"
    :added="tool.added"
    :removed="tool.removed"
    :content="tool.output"
    :status="tool.status"
    :code-block="codeBlock"
    @open-file="emit('openFile', $event)"
    @copy="emit('copy', $event)"
  />
</template>
