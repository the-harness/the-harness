<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: List, Pane, Button. Adaptation: a compact installed-extension list with enable and disable actions. -->
<script setup lang="ts">
import { nextTick } from "vue";
import { Button, Pane } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { notesSettings } from "../workbench/NotesExtension.vue";

const workbench = useService(UiWorkbenchService);
const storage = useService(UiStorageService);
const notifications = useService(UiNotificationService);
const notes = storage.use(...notesSettings, new CrossTabSync());

async function toggle() {
  notes.enabled = !notes.enabled;
  await nextTick();
  if (notes.enabled) workbench.open("notes");
  notifications.notify(notes.enabled ? "Workspace Notes enabled" : "Workspace Notes disabled");
}
</script>
<template>
  <section class="panel-fill extensions-panel">
    <Pane class="extension-section" title="Built-in" :count="1" open>
      <div class="extension-row">
        <span class="extension-icon i-codicon-notebook" />
        <div class="extension-details">
          <strong>Workspace Notes</strong>
          <p>Notes for the current workspace.</p>
          <div class="extension-actions">
            <span class="muted">Harness</span><span class="spacer" />
            <Button :variant="notes.enabled ? 'secondary' : 'primary'" @click="toggle">
              {{ notes.enabled ? "Disable extension" : "Enable extension" }}
            </Button>
          </div>
        </div>
      </div>
    </Pane>
  </section>
</template>
