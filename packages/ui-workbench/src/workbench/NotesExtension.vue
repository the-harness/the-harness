<script lang="ts">
import { z } from "zod";

export const notesSettings = [
  "core:notes",
  {
    enabled: z.boolean().default(false),
  },
] as const;
</script>

<script setup lang="ts">
import { IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { ChatComposerSlot, UiWorkbenchService } from "@harness/ui-workbench";
import NotesPanel from "../panels/NotesPanel.vue";

const workbench = useService(UiWorkbenchService);

workbench.use({
  id: "workspace.notes",
  panels: [
    {
      id: "notes",
      title: "Notes",
      icon: "i-codicon-notebook",
      component: NotesPanel,
      location: "right",
    },
  ],
  commands: [
    {
      id: "notes.open",
      title: "Notes: Open workspace notes",
      icon: "i-codicon-notebook",
      run: () => workbench.open("notes"),
    },
  ],
});
</script>

<template>
  <ChatComposerSlot.Contribute v-slot="{ Next }">
    <component :is="Next" />
    <IconButton
      icon="i-codicon-notebook"
      label="Open workspace notes"
      @click="workbench.open('notes')"
    />
  </ChatComposerSlot.Contribute>
</template>
