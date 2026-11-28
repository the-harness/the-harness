<script setup lang="ts">
export interface RunStopMessageData {
  readonly stopReason: string;
  readonly message?: string;
}

defineProps<{
  message: RunStopMessageData;
}>();
</script>

<template>
  <div class="my-2 flex items-center gap-2 text-[11px] text-[var(--muted)]">
    <span class="h-px flex-1 bg-[var(--border)]" />
    <span>
      Run {{ message.stopReason }}
      <template v-if="message.message">: {{ message.message }}</template>
    </span>
    <span class="h-px flex-1 bg-[var(--border)]" />
  </div>
</template>
