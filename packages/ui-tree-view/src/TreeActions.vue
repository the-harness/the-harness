<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: TreeView, ActionBar
  Adaptation: Render row inline actions using @harness/ui-components-base IconButton.
-->
<script setup lang="ts">
import { IconButton } from "@harness/ui-components-base";
import type { TreeAction } from "./types";

const props = defineProps<{ actions: readonly TreeAction[]; label: string }>();
const emit = defineEmits<{ action: [action: TreeAction] }>();
</script>
<template>
  <div class="actions" role="toolbar" :aria-label="`Actions for ${props.label}`">
    <IconButton
      v-for="item in props.actions"
      :key="item.id"
      :icon="item.icon"
      :label="item.label"
      :disabled="item.disabled"
      @click.stop="emit('action', item)"
    />
  </div>
</template>
