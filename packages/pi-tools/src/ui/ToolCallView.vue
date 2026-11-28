<script setup lang="ts">
import { LinesToolView } from "@harness/ui-components-tools";

defineProps<{
  tool: {
    name: string;
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
    :label="tool.name"
    icon="i-codicon-tools"
    :detail="tool.target"
    :content="tool.output"
    :status="tool.status"
    @copy="emit('copy', $event)"
  />
</template>
