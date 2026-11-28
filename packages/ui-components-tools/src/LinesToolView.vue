<script setup lang="ts">
import { IconButton } from "@harness/ui-components-base";
import ToolDisclosure from "./ToolDisclosure.vue";

withDefaults(
  defineProps<{
    label: string;
    icon?: string;
    detail?: string;
    content?: string;
    status?: "running" | "ok" | "error";
  }>(),
  {
    icon: "i-codicon-search",
    status: "ok",
  },
);

const emit = defineEmits<{
  copy: [text?: string];
}>();
</script>

<template>
  <ToolDisclosure :icon="icon" :name="label" :status="status" :expandable="Boolean(content)">
    <span v-if="detail" class="tl-dim" :title="detail">{{ detail }}</span>
    <template #body>
      <div class="tool-panel">
        <div class="tool-panel-head">
          <span class="tool-panel-path tl-dim">{{ detail }}</span>
          <span class="spacer" />
          <IconButton
            icon="i-codicon-copy"
            label="Copy output"
            @click.stop="emit('copy', content)"
          />
        </div>
        <pre class="tool-output">{{ content ?? "" }}</pre>
      </div>
    </template>
  </ToolDisclosure>
</template>
