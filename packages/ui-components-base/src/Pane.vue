<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    count?: number;
    open?: boolean;
  }>(),
  {
    open: true,
  },
);
</script>

<template>
  <details :open="open">
    <summary class="pane-heading">
      <span class="i-codicon-chevron-right disclosure-icon" aria-hidden="true" />
      <span>{{ title }}</span>
      <span v-if="count !== undefined" class="count-badge">{{ count }}</span>
    </summary>
    <slot />
  </details>
</template>
