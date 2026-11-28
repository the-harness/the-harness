<script setup lang="ts">
import { useService } from "@harness/ui-di";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import { z } from "zod";

const notes = useService(UiStorageService)
  .scope("workspace", "default")
  .use(
    "core:notes",
    {
      content: z
        .string()
        .default(
          "Things to explore\n\n• Drag this tab into another panel\n• Split chat and notes side by side\n• Add your own view with workbench.use()\n",
        ),
    },
    new CrossTabSync(),
  );
</script>

<template>
  <section class="panel-fill notes-panel">
    <div class="view-toolbar">
      <span class="i-codicon-notebook" /><strong>Workspace notes</strong
      ><span class="spacer" /><span class="tag">EXTENSION</span>
    </div>
    <textarea v-model="notes.content" aria-label="Workspace notes" placeholder="Capture an idea…" />
    <div class="panel-note"><span class="i-codicon-check" />Saved in this browser</div>
  </section>
</template>
