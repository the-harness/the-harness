<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "text";
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
  }>(),
  {
    variant: "secondary",
    type: "button",
    disabled: false,
  },
);

const buttonClass = computed(() =>
  props.variant === "primary"
    ? "primary-button"
    : props.variant === "text"
      ? "text-button"
      : "secondary-button",
);
</script>

<template>
  <button :type="type" :class="buttonClass" :disabled="disabled">
    <slot />
  </button>
</template>
