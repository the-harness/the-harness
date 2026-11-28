<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: ContextMenu, Menu. Adaptation: slot triggers and explicit anchors for tree rows, with shared focus and action handling. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent } from "reka-ui";
import MenuGroups from "./MenuGroups.vue";
import type { ResolvedMenuGroup } from "./menu.ts";
import { guardMenuComposition, guardMenuEscape, useMenuInteraction } from "./interaction.ts";
import "./menu.css";

const props = withDefaults(defineProps<{
  groups: readonly ResolvedMenuGroup[];
  label: string;
  restoreFocus?: boolean;
  onError?: (error: unknown) => void;
}>(), { restoreFocus: true });
const open = defineModel<boolean>("open", { default: false });
const groups = computed(() => props.groups);
// Reka's prop forwarders must see a defined reference on their first render.
const reference = shallowRef({ getBoundingClientRect: () => new DOMRect() });
let focusTarget: HTMLElement | undefined;
let keyboard = false;
const interaction = useMenuInteraction(open, groups, () => focusTarget,
  () => props.restoreFocus, (error) => (props.onError ?? reportError)(error));

function rememberTarget(event: Event) {
  if (event instanceof MouseEvent) {
    const { clientX, clientY } = event;
    reference.value = { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) };
  }
  keyboard = false;
  const focused = document.activeElement;
  if (event.type === "pointerdown" || focused !== document.body) {
    focusTarget = focused instanceof HTMLElement ? focused : undefined;
  }
}

function show(anchor: MouseEvent | HTMLElement, returnFocus?: HTMLElement): void {
  if (!groups.value.length) return;
  keyboard = anchor instanceof HTMLElement;
  if (anchor instanceof HTMLElement) {
    reference.value = { getBoundingClientRect: () => {
      const bounds = anchor.getBoundingClientRect();
      return new DOMRect(bounds.left, bounds.bottom, 0, 0);
    } };
    focusTarget = returnFocus ?? anchor;
  } else {
    anchor.preventDefault();
    const { clientX, clientY } = anchor;
    reference.value = { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) };
    focusTarget = returnFocus ?? (anchor.currentTarget instanceof HTMLElement
      ? anchor.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  }
  open.value = true;
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
  if (!(event.currentTarget instanceof HTMLElement) || !groups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const focused = document.activeElement;
  show(event.currentTarget, focused instanceof HTMLElement && event.currentTarget.contains(focused)
    ? focused : undefined);
}

function opened(event: Event) {
  const content = interaction.opened(event);
  if (!content) return;
  event.preventDefault();
  const first = keyboard ? content.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])') : undefined;
  (first ?? content).focus({ preventScroll: true });
}

defineExpose({ show, close: () => { open.value = false; } });
</script>

<template>
  <ContextMenuRoot :open="open && !!groups.length" :modal="false"
    @update:open="open = $event && !!groups.length">
    <ContextMenuTrigger v-if="$slots.default" as-child :disabled="!groups.length"
      @contextmenu="rememberTarget" @pointerdown="rememberTarget"
      @keydown.capture="guardMenuComposition" @keydown="onKeydown">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent class="popup-menu harness-menu" loop :aria-label="label" :reference="reference"
        :collision-padding="8" @open-auto-focus="opened" @close-auto-focus="interaction.closeAutoFocus"
        @interact-outside="interaction.outside" @keydown.capture="guardMenuComposition"
        @escape-key-down="guardMenuEscape">
        <MenuGroups :groups="groups" kind="context" @select="interaction.select" />
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
