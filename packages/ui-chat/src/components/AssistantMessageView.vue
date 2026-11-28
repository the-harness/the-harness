<script setup lang="ts">
import { IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { computed, onScopeDispose, ref } from "vue";
import { ChatBlockSlot } from "../slots.ts";
import type { SessionMessage } from "../types.ts";
import ActivityRun from "./ActivityRun.vue";

const props = defineProps<{
  message: SessionMessage;
}>();

const notifications = useService(UiNotificationService);
const duration = computed(() =>
  props.message.durationMs !== undefined
    ? `${Math.max(1, Math.round(props.message.durationMs / 1000))}s`
    : undefined,
);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => clearTimeout(copiedTimer));

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.message.text);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    notifications.notify("Clipboard is not available in this browser");
  }
}
</script>

<template>
  <div class="a-msg">
    <ActivityRun
      :items="message.activities ?? []"
      :streaming="message.streaming"
      :duration="duration"
    >
      <template #default="{ item }">
        <ChatBlockSlot :block="item" />
      </template>
    </ActivityRun>
    <ChatBlockSlot
      v-if="message.text"
      :block="{ id: message.id, kind: 'text', text: message.text, streaming: message.streaming }"
    >
      <div class="whitespace-pre-wrap break-words">{{ message.text }}</div>
    </ChatBlockSlot>
    <div v-if="!message.streaming && message.text" class="a-msg-ft">
      <IconButton
        :icon="copied ? 'i-codicon-check' : 'i-codicon-copy'"
        :label="copied ? 'Response copied' : 'Copy response'"
        @click="copyText"
      />
      <span class="sr-only" role="status">{{ copied ? "Response copied" : "" }}</span>
    </div>
  </div>
</template>
