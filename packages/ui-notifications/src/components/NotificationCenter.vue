<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Dialog, ButtonBar. Adaptation: platform button order from VS Code 1f8d8b21a2e98baccf533e6f453156b0a323ea84 dialog.ts, retaining original action indices and cancel-first focus. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { Button, ContextMenu } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import { computed } from "vue";
import { UiNotificationService, type NotificationOptions } from "../index.ts";

const notifications = useService(UiNotificationService);
const toasts = computed(() => notifications.prompts.value.filter((prompt) => !prompt.modal));
const dialogs = computed(() =>
  notifications.prompts.value.filter((prompt) => prompt.modal).slice(0, 1),
);
const icons = {
  info: "i-codicon-info",
  warning: "i-codicon-warning",
  error: "i-codicon-error",
};
const primaryOnRight = /Mac|Linux|iPhone|iPad|iPod/.test(navigator.platform);

function dialogButtons(prompt: NotificationOptions) {
  const actions = prompt.actions.map((label, index) => ({
    label,
    index: index as number | undefined,
    cancel: index === prompt.cancelAction,
  }));
  const cancel = actions.find((action) => action.cancel) ?? {
    label: actions.length ? "Cancel" : "OK",
    index: undefined,
    cancel: true,
  };
  const buttons = actions.filter((action) => !action.cancel);
  const primary = buttons[0] ?? cancel;
  if (primaryOnRight) {
    buttons.splice(1, 0, cancel);
    buttons.reverse();
  } else {
    buttons.push(cancel);
  }
  return buttons.map((button) => ({ ...button, primary: button === primary }));
}
</script>

<template>
  <div class="ui-notification-stack">
    <ContextMenu
      v-for="prompt in toasts"
      :key="prompt.id"
      label="Notification actions"
      :groups="notifications.menu.resolve({ id: prompt.id, message: prompt.message })"
    >
      <section
        class="ui-notification-toast"
        :data-severity="prompt.severity"
      >
        <div class="ui-notification-heading">
          <span class="ui-notification-icon" :class="icons[prompt.severity]" aria-hidden="true" />
          <span
            class="ui-notification-message"
            :role="prompt.severity === 'error' ? 'alert' : 'status'"
            >{{ prompt.message }}</span
          >
          <button
            type="button"
            class="ui-notification-close"
            aria-label="Dismiss notification"
            @click="prompt.finish()"
          >
            ×
          </button>
        </div>
        <div v-if="prompt.actions.length" class="ui-notification-actions">
          <Button v-for="(label, index) in prompt.actions" :key="index" @click="prompt.finish(index)">
            {{ label }}
          </Button>
        </div>
      </section>
    </ContextMenu>
    <ContextMenu v-if="notifications.message.value" label="Notification actions"
      :groups="notifications.menu.resolve({ message: notifications.message.value })">
      <div class="ui-notification-toast">
        <div class="ui-notification-heading">
          <span class="ui-notification-message" role="status">{{ notifications.message.value }}</span>
          <button
            type="button"
            class="ui-notification-close"
            aria-label="Dismiss notification"
            @click="notifications.dismiss()"
          >
            ×
          </button>
        </div>
      </div>
    </ContextMenu>
  </div>

  <AlertDialogRoot
    v-for="prompt in dialogs"
    :key="prompt.id"
    :open="true"
    @update:open="
      (open) => {
        if (!open) prompt.finish(prompt.cancelAction);
      }
    "
  >
    <AlertDialogPortal>
      <AlertDialogOverlay class="ui-notification-overlay" />
      <AlertDialogContent
        class="ui-notification-dialog"
        :data-severity="prompt.severity"
        @open-auto-focus.prevent
      >
        <div class="ui-notification-heading">
          <span class="ui-notification-icon" :class="icons[prompt.severity]" aria-hidden="true" />
          <AlertDialogTitle class="ui-notification-title">{{ prompt.message }}</AlertDialogTitle>
        </div>
        <AlertDialogDescription class="ui-notification-detail">{{
          prompt.detail
        }}</AlertDialogDescription>
        <div class="ui-notification-actions">
          <template v-for="button in dialogButtons(prompt)" :key="button.index ?? 'cancel'">
            <AlertDialogCancel v-if="button.cancel" as-child>
              <Button :variant="button.primary ? 'primary' : 'secondary'">{{
                button.label
              }}</Button>
            </AlertDialogCancel>
            <Button
              v-else
              :variant="button.primary ? 'primary' : 'secondary'"
              @click="prompt.finish(button.index)"
              >{{ button.label }}</Button
            >
          </template>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style scoped>
.ui-notification-stack {
  position: fixed;
  right: 16px;
  bottom: 36px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: min(420px, calc(100vw - 32px));
  max-height: calc(100dvh - 72px);
  overflow: auto;
}

.ui-notification-toast,
.ui-notification-dialog {
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--raised);
  color: var(--fg);
  box-shadow: 0 4px 12px var(--shadow);
  font-size: 12px;
}

.ui-notification-toast {
  padding: 8px 12px;
}

.ui-notification-heading,
.ui-notification-actions {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ui-notification-message,
.ui-notification-title,
.ui-notification-detail {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.ui-notification-icon {
  flex: none;
  align-self: center;
  color: var(--accent);
}

[data-severity="warning"] .ui-notification-icon {
  color: var(--warning-fg);
}

[data-severity="error"] .ui-notification-icon {
  color: var(--red);
}

.ui-notification-actions {
  justify-content: flex-end;
  flex-wrap: wrap;
  margin-top: 8px;
}

.ui-notification-close {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  opacity: 0.75;
}

.ui-notification-close:hover {
  opacity: 1;
}

.ui-notification-overlay {
  position: fixed;
  inset: 0;
  z-index: 2599;
  background: #0006;
}

.ui-notification-dialog {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: 2600;
  width: min(440px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  transform: translate(-50%, -50%);
  padding: 16px;
}

.ui-notification-title {
  font-size: 14px;
  font-weight: 600;
}

.ui-notification-detail:not(:empty) {
  margin: 8px 0 0;
}
</style>
