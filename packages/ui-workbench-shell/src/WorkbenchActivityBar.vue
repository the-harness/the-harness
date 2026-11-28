<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: ActivityBar, CompositeBar. Adaptation: Harness view navigation; horizontal placement and click behavior follow VS Code 1f8d8b21a2e98baccf533e6f453156b0a323ea84 sidebarPart.ts and paneCompositeBar.ts. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { RovingFocusGroup, RovingFocusItem } from "reka-ui";

defineProps<{
  position: "default" | "top" | "bottom";
  side: "left" | "right";
  expanded: boolean;
}>();
defineEmits<{ activate: [] }>();
</script>

<template>
  <RovingFocusGroup
    as="nav"
    :orientation="position === 'default' ? 'vertical' : 'horizontal'"
    class="activity-bar"
    :class="[side, position, { horizontal: position !== 'default' }]"
    aria-label="Workbench views"
    @pointerdown.stop
    @mousedown.stop
    @dblclick.stop
  >
    <RovingFocusItem as-child>
      <button
        type="button"
        aria-label="Conversations"
        title="Conversations"
        :class="{ active: expanded }"
        :aria-expanded="expanded"
        @click="$emit('activate')"
      >
        <span class="i-codicon-comment-discussion" aria-hidden="true" />
      </button>
    </RovingFocusItem>
    <slot />
  </RovingFocusGroup>
</template>
