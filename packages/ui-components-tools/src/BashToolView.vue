<script setup lang="ts">
import type { Component } from "vue";
import { IconButton } from "@harness/ui-components-base";
import ToolDisclosure from "./ToolDisclosure.vue";

withDefaults(
  defineProps<{
    label?: string;
    command?: string;
    output?: string;
    duration?: string;
    status?: "running" | "ok" | "error";
    codeBlock?: Component<{ code: string; lang?: string; framed?: boolean }>;
  }>(),
  {
    label: "Bash",
    status: "ok",
  },
);

const emit = defineEmits<{
  copy: [text?: string];
}>();
</script>

<template>
  <ToolDisclosure
    icon="i-codicon-terminal"
    :name="label"
    :status="status"
    :expandable="Boolean(command || output)"
  >
    <code v-if="command" class="tl-mono">{{ command }}</code>
    <template #trailing>
      <span v-if="duration" class="tl-chip">{{ duration }}</span>
    </template>
    <template #body>
      <div class="tool-panel">
        <div v-if="command" class="tool-panel-head">
          <component :is="codeBlock" v-if="codeBlock" :code="command" lang="bash" :framed="false" />
          <code v-else class="tl-mono">{{ command }}</code>
          <span class="spacer" />
          <IconButton
            icon="i-codicon-copy"
            label="Copy command"
            @click.stop="emit('copy', command)"
          />
        </div>
        <pre v-if="output" class="tool-output">{{ output }}</pre>
      </div>
    </template>
  </ToolDisclosure>
</template>
