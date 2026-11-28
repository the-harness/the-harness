<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Banner, Button, IconButton. Adaptation: per-chat plain-text extension notifications with worker actions, dismissal and submission lifecycle. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, effectScope, reactive, watch } from "vue";
import { useService } from "@harness/ui-di";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { IconButton } from "@harness/ui-components-base";
import { ExtensionHostClientService } from "../client.ts";

const props = defineProps<{ sessionId?: string }>();
const client = useService(ExtensionHostClientService);
const chats = useService(UiChatManagerService);
const pending = reactive(new Set<string>());
const errors = reactive(new Map<string, string>());
const notifications = computed(() =>
  props.sessionId
    ? [...client.chatInputNotifications.values()].filter(
        (item) => !item.sessionTypes || item.sessionTypes.includes("local"),
      )
    : [],
);

async function run(key: string, action: () => Promise<void>) {
  if (pending.has(key)) return;
  pending.add(key);
  errors.delete(key);
  try {
    await action();
  } catch (error) {
    errors.set(key, error instanceof Error ? error.message : String(error));
  } finally {
    pending.delete(key);
  }
}

watch(
  () => props.sessionId,
  (sessionId, _previous, onCleanup) => {
    if (!sessionId) return;
    const hooks = effectScope();
    onCleanup(() => hooks.stop());
    hooks.run(() => {
      chats.get(sessionId).hooks.submitMessage.use((_, next) => {
        for (const item of notifications.value)
          if (item.autoDismissOnMessage) {
            void client
              .dismissChatInputNotification(item.key, true)
              .catch((error) =>
                errors.set(item.key, error instanceof Error ? error.message : String(error)),
              );
          }
        return next();
      });
    });
  },
  { immediate: true },
);
watch(
  () => [...client.chatInputNotifications.keys()],
  (keys) => {
    for (const key of errors.keys()) if (!keys.includes(key)) errors.delete(key);
  },
);
</script>

<template>
  <div v-if="notifications.length" class="chat-input-notifications">
    <div
      v-for="item in notifications"
      :key="item.key"
      class="chat-input-notification"
      :class="{ warning: item.severity === 1, error: item.severity === 2 }"
      :role="item.severity === 2 ? 'alert' : 'status'"
      aria-label="Chat input notification"
    >
      <span
        class="notification-icon"
        :class="
          item.severity === 2
            ? 'i-codicon-error'
            : item.severity === 1
              ? 'i-codicon-warning'
              : 'i-codicon-info'
        "
        aria-hidden="true"
      />
      <div class="notification-content">
        <div>{{ item.message }}</div>
        <div v-if="item.description" class="notification-description">{{ item.description }}</div>
        <div v-if="item.actions.length" class="notification-actions">
          <button
            v-for="(action, index) in item.actions"
            :key="index"
            type="button"
            :disabled="pending.has(item.key)"
            @click="run(item.key, () => client.runChatInputAction(item.key, index))"
          >
            {{ action.label }}
          </button>
        </div>
        <div v-if="errors.has(item.key)" role="alert" class="notification-error">
          {{ errors.get(item.key) }}
        </div>
      </div>
      <IconButton
        v-if="item.dismissible"
        icon="i-codicon-close"
        label="Dismiss notification"
        :disabled="pending.has(item.key)"
        @click="run(item.key, () => client.dismissChatInputNotification(item.key))"
      />
    </div>
  </div>
  <slot />
</template>

<style scoped>
.chat-input-notifications {
  display: grid;
  gap: 6px;
  padding: 8px 8px 0;
}
.chat-input-notification {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  background: var(--raised);
  color: var(--fg);
  font-size: 12px;
  line-height: 18px;
}
.notification-icon {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}
.warning .notification-icon {
  color: var(--warning-fg);
}
.error .notification-icon,
.notification-error {
  color: var(--red);
}
.notification-content {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.notification-description {
  color: var(--muted);
}
.notification-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.notification-actions button {
  padding: 3px 8px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  background: var(--raised);
  color: var(--fg);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}
.notification-actions button:hover {
  background: var(--hover);
}
.notification-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.notification-actions button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
</style>
