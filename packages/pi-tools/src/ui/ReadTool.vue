<script setup lang="ts">
import type { Component } from "vue";
import { ReadToolView } from "@harness/ui-components-tools";

defineProps<{
  tool: {
    status: "running" | "ok" | "error";
    target?: string;
    range?: string;
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
  <ReadToolView
    label="Read"
    :path="tool.target"
    :range="tool.range"
    :content="tool.output"
    :status="tool.status"
    :code-block="codeBlock"
    @open-file="emit('openFile', $event)"
    @copy="emit('copy', $event)"
  />
</template>
