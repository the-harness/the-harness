<script setup lang="ts">
import { LinesToolView } from "@harness/ui-components-tools";

defineProps<{
  tool: {
    status: "running" | "ok" | "error";
    target?: string;
    output?: string;
  };
}>();

const emit = defineEmits<{
  copy: [text?: string];
}>();
</script>

<template>
  <LinesToolView
    label="List"
    icon="i-codicon-list-flat"
    :detail="tool.target"
    :content="tool.output"
    :status="tool.status"
    @copy="emit('copy', $event)"
  />
</template>
