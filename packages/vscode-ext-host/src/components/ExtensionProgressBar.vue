<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; component: ProgressBar. Adaptation: A declarative bar for extension progress notifications and view headers. -->
<script setup lang="ts">
defineProps<{ label: string; value?: number }>();
</script>

<template>
  <div
    class="extension-progress-track"
    role="progressbar"
    :aria-label="label"
    :aria-valuenow="value"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div
      class="extension-progress-fill"
      :class="{ 'extension-progress-indeterminate': value === undefined }"
      :style="value === undefined ? undefined : { width: value + '%' }"
    />
  </div>
</template>

<style scoped>
.extension-progress-track {
  height: 2px;
  overflow: hidden;
  background: var(--border);
}
.extension-progress-fill {
  height: 100%;
  background: var(--vscode-progressBar-background, var(--accent));
  transition: width 100ms linear;
}
.extension-progress-indeterminate {
  width: 25%;
  animation: extension-progress-slide 1.4s ease-in-out infinite;
}
@keyframes extension-progress-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(400%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .extension-progress-indeterminate {
    animation: none;
  }
}
</style>
