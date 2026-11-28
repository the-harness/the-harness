<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Menu. Adaptation: shared reactive rows and submenus, with Reka navigation and pointer grace. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed } from "vue";
import {
  DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuPortal, DropdownMenuSeparator,
  ContextMenuItem, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  ContextMenuPortal, ContextMenuSeparator,
} from "reka-ui";
import { MenuAction, type ResolvedMenuGroup } from "./menu.ts";
import { guardMenuComposition, guardMenuEscape } from "./interaction.ts";

const props = defineProps<{
  groups: readonly ResolvedMenuGroup[];
  kind: "context" | "dropdown";
  path?: readonly string[];
}>();
const emit = defineEmits<{ select: [path: readonly string[]] }>();
const parts = computed(() => props.kind === "context"
  ? { Item: ContextMenuItem, Sub: ContextMenuSub, Trigger: ContextMenuSubTrigger,
      Content: ContextMenuSubContent, Portal: ContextMenuPortal, Separator: ContextMenuSeparator }
  : { Item: DropdownMenuItem, Sub: DropdownMenuSub, Trigger: DropdownMenuSubTrigger,
      Content: DropdownMenuSubContent, Portal: DropdownMenuPortal, Separator: DropdownMenuSeparator });
const indicators = computed(() => props.groups.some((group) => group.items.some(({ item }) =>
  item.icon || (item instanceof MenuAction && (item.type === "checkbox" || item.type === "radio")))));
const pathFor = (groupId: string, id: string) => [...(props.path ?? []), groupId, id];
</script>

<template>
  <template v-for="(group, index) in groups" :key="group.id">
    <component :is="parts.Separator" v-if="index > 0" class="menu-separator" />
    <template v-for="{ item, groups: submenuGroups } in group.items" :key="item.id">
      <component :is="parts.Sub" v-if="submenuGroups">
        <component :is="parts.Trigger" class="menu-item" :disabled="item.disabled" :text-value="item.label">
          <span v-if="indicators" class="menu-item-indicator" aria-hidden="true">
            <span v-if="item.icon" :class="item.icon" />
          </span>
          <span class="menu-item-label">{{ item.label }}</span>
          <svg class="menu-submenu-arrow" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
            <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </component>
        <component :is="parts.Portal">
          <component :is="parts.Content" class="popup-menu harness-menu harness-submenu" loop
            :aria-label="item.label" :collision-padding="8" :side-offset="-4" :align-offset="-4"
            @keydown.capture="guardMenuComposition" @escape-key-down="guardMenuEscape">
            <MenuGroups :groups="submenuGroups" :kind="kind" :path="pathFor(group.id, item.id)" @select="emit('select', $event)" />
          </component>
        </component>
      </component>
      <component :is="parts.Item" v-else-if="item instanceof MenuAction" class="menu-item" :class="{ danger: item.danger }"
        :disabled="item.disabled" :text-value="item.label"
        :role="item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem'"
        :aria-checked="item.type === 'checkbox' || item.type === 'radio' ? !!item.checked : undefined"
        @select="emit('select', pathFor(group.id, item.id))">
        <span v-if="indicators" class="menu-item-indicator" aria-hidden="true">
          <svg v-if="item.checked" viewBox="0 0 16 16" width="16" height="16">
            <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <span v-else-if="item.icon && item.type !== 'checkbox' && item.type !== 'radio'" :class="item.icon" />
        </span>
        <span class="menu-item-label">{{ item.label }}</span>
        <kbd v-if="item.shortcut" aria-hidden="true">{{ item.shortcut }}</kbd>
      </component>
    </template>
  </template>
</template>
