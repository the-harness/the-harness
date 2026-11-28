<script setup lang="ts">
import type { Component } from "vue";
import { BashToolView } from "@harness/ui-components-tools";

defineProps<{
  tool: {
    status: "running" | "ok" | "error";
    command?: string;
    output?: string;
    duration?: string;
  };
  codeBlock?: Component<{ code: string; lang?: string; framed?: boolean }>;
}>();

const emit = defineEmits<{
  copy: [text?: string];
}>();
</script>

<template>
  <BashToolView
    label="Bash"
    :command="tool.command"
    :output="tool.output"
    :duration="tool.duration"
    :status="tool.status"
    :code-block="codeBlock"
    @copy="emit('copy', $event)"
  />
</template>
