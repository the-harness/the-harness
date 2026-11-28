<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: IconLabel. Adaptation: preset-supplied image or current-color mask with a generic fallback. -->
<script setup lang="ts">
import type { AgentPresetIcon } from "@harness/agent-preset";

defineProps<{ icon?: AgentPresetIcon }>();
</script>

<template>
  <span
    v-if="icon?.monochrome"
    class="agent-preset-icon monochrome"
    :style="{ maskImage: `url(${JSON.stringify(icon.src)})` }"
    aria-hidden="true"
  />
  <img v-else-if="icon" :src="icon.src" class="agent-preset-icon" alt="" draggable="false" aria-hidden="true" />
  <span v-else class="agent-preset-icon i-codicon-sparkle" aria-hidden="true" />
</template>

<style scoped>
.agent-preset-icon {
  display: inline-block;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  object-fit: contain;
}

.monochrome {
  background-color: currentColor;
  mask-mode: alpha;
  mask-position: center;
  mask-size: contain;
  mask-repeat: no-repeat;
}
</style>
