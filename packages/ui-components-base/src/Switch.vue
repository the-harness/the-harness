<script setup lang="ts">
defineProps<{
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}>();

const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="inline-flex items-center gap-2 cursor-pointer select-none">
    <input
      v-model="model"
      type="checkbox"
      role="switch"
      :aria-checked="model"
      :aria-label="ariaLabel ?? label"
      :disabled="disabled"
    />
    <span v-if="label">{{ label }}</span>
  </label>
</template>
