<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: ActivityBar, Menu. Adaptation: The same Manage actions in the activity bar or titlebar. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  RovingFocusItem,
} from "reka-ui";
import { nextTick, ref } from "vue";

defineProps<{
  side: "left" | "right" | "bottom";
  shortcutLabel: string;
}>();
const emit = defineEmits<{ settings: []; commands: [] }>();
const trigger = ref<InstanceType<typeof DropdownMenuTrigger>>();
let pendingAction: "settings" | "commands" | undefined;

function closeAutoFocus(event: Event) {
  const action = pendingAction;
  pendingAction = undefined;
  if (!action) return;
  event.preventDefault();
  void nextTick(() => {
    const target = trigger.value?.$el;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    if (action === "settings") emit("settings");
    else emit("commands");
  });
}
</script>

<template>
  <DropdownMenuRoot :modal="false">
    <DropdownMenuTrigger ref="trigger" as-child>
      <RovingFocusItem as-child>
        <button class="manage-button" type="button" aria-label="Manage" title="Manage">
          <span class="i-codicon-settings-gear" aria-hidden="true" />
        </button>
      </RovingFocusItem>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="popup-menu"
        aria-label="Manage"
        :side="side"
        align="end"
        :side-offset="1"
        :align-offset="4"
        :collision-padding="8"
        @close-auto-focus="closeAutoFocus"
      >
        <DropdownMenuItem class="menu-item" @select="pendingAction = 'settings'">
          <span>Settings</span><span class="spacer" />
          <kbd aria-hidden="true">{{ shortcutLabel }},</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem class="menu-item" @select="pendingAction = 'commands'">
          <span>Command Palette…</span><span class="spacer" />
          <kbd aria-hidden="true">{{ shortcutLabel }}K</kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
