<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: StatusBarEntry, NotificationsList. Adaptation: Workspace-scoped extension progress in the status bar and notification cards. -->
<script setup lang="ts">
import { Button } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { ProgressLocation } from "@harness/vscode-types";
import { computed } from "vue";
import { ExtensionHostClientService } from "../client.ts";
import ExtensionProgressBar from "./ExtensionProgressBar.vue";

const host = useService(ExtensionHostClientService);
const entries = computed(() => [...host.progressEntries.values()]);
const notifications = computed(() =>
  entries.value.filter((entry) => entry.location === ProgressLocation.Notification),
);
const windowProgress = computed(() =>
  entries.value.findLast((entry) => entry.location === ProgressLocation.Window),
);
</script>

<template>
  <div v-if="windowProgress" class="extension-progress-window" role="status">
    <span class="i-codicon-loading animate-spin" aria-hidden="true" />
    <span class="extension-progress-window-label">
      {{ windowProgress.title }}{{ windowProgress.message ? ` — ${windowProgress.message}` : "" }}
    </span>
  </div>
  <Teleport to="body">
    <div v-if="notifications.length" class="extension-progress-notifications">
      <section
        v-for="entry in notifications"
        :key="entry.id"
        class="extension-progress-notification"
      >
        <div class="extension-progress-heading">
          <div role="status">
            <div>{{ entry.title }}</div>
            <div v-if="entry.message" class="extension-progress-message">{{ entry.message }}</div>
          </div>
          <Button
            v-if="entry.cancellable"
            :aria-label="`Cancel ${entry.title}`"
            @click="host.cancelProgress(entry)"
            >Cancel</Button
          >
        </div>
        <ExtensionProgressBar :label="entry.title" :value="entry.worked" />
      </section>
    </div>
  </Teleport>
  <slot />
</template>

<style scoped>
.extension-progress-window {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 0 7px;
}
.extension-progress-window-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.extension-progress-notifications {
  position: fixed;
  top: 44px;
  right: 16px;
  z-index: 1000;
  display: grid;
  gap: 6px;
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100dvh - 88px);
  overflow: auto;
}
.extension-progress-notification {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px var(--shadow);
  background: var(--raised);
  color: var(--fg);
  font-size: 12px;
}
.extension-progress-heading {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 8px;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}
.extension-progress-message {
  color: var(--muted);
  margin-top: 4px;
}
</style>
