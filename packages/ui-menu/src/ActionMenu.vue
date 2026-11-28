<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Dropdown, Menu. Adaptation: reactive menu data with Reka dismissal and keyboard navigation. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent } from "reka-ui";
import MenuGroups from "./MenuGroups.vue";
import type { ResolvedMenuGroup } from "./menu.ts";
import { guardMenuComposition, guardMenuEscape, useMenuInteraction } from "./interaction.ts";
import "./menu.css";

const props = withDefaults(defineProps<{
  groups: readonly ResolvedMenuGroup[];
  label: string;
  restoreFocus?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  onError?: (error: unknown) => void;
}>(), { restoreFocus: true });
const open = defineModel<boolean>("open", { default: false });
const groups = computed(() => props.groups);
const trigger = ref<HTMLButtonElement>();
const interaction = useMenuInteraction(open, groups, () => trigger.value,
  () => props.restoreFocus, (error) => (props.onError ?? reportError)(error));
</script>

<template>
  <DropdownMenuRoot :open="open && !!groups.length" :modal="false"
    @update:open="open = $event && !!groups.length">
    <DropdownMenuTrigger as-child>
      <button ref="trigger" class="menu-trigger" :aria-label="label" :title="label" type="button"
        :disabled="!groups.length" @keydown.capture="guardMenuComposition">
        <slot />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="popup-menu harness-menu" loop :aria-label="label"
        :side="side" :side-offset="5" :collision-padding="8" :align="align ?? 'end'"
        @open-auto-focus="interaction.opened" @close-auto-focus="interaction.closeAutoFocus"
        @interact-outside="interaction.outside" @keydown.capture="guardMenuComposition"
        @escape-key-down="guardMenuEscape">
        <MenuGroups :groups="groups" kind="dropdown" @select="interaction.select" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
