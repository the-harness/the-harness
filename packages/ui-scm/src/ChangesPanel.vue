<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: List
  Adaptation: Focusable resource rows using the Changes panel's existing layout and theme tokens.
-->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from "vue";
import { useService } from "@harness/ui-di";
import { UiScmService, type ScmResource, type ScmMenuContext } from "@harness/ui-scm";
import { ContextMenu } from "@harness/ui-menu";

const scm = useService(UiScmService);
const { providers, collapsedGroups } = scm;
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuContext = shallowRef<ScmMenuContext>();
const menuGroups = computed(() => {
  const context = menuContext.value;
  return context && scm.isMenuTargetCurrent(context)
    ? scm.menu.resolve(context) : [];
});

async function openMenu(context: ScmMenuContext, event: MouseEvent | KeyboardEvent) {
  if (event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  menuContext.value = context;
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

function resourceLabel(resource: string | ScmResource): string {
  const path = typeof resource === "string" ? resource : resource.resourceUri.path;
  return path.split("/").at(-1) || path;
}
</script>

<template>
  <section class="panel-fill changes-panel">
    <div v-if="providers.length === 0" class="changes-empty">
      No changes available for this workspace.
    </div>
    <div v-for="provider in providers" :key="provider.handle" class="scm-provider"
      @contextmenu="openMenu({ provider }, $event)"
      @keydown="openMenu({ provider }, $event)">
      <div class="scm-header">{{ provider.label }}</div>
      <input
        v-model="provider.inputValue"
        @contextmenu.stop
        @keydown.stop
        class="scm-input"
        type="text"
        :placeholder="provider.inputPlaceholder || 'Message (Enter to commit)'"
        @keydown.enter="scm.submitInput(provider)"
      />
      <template v-for="[gid, group] in provider.groups" :key="gid">
        <div v-if="!group.hideWhenEmpty || group.resources.length" class="scm-group">
          <button
            type="button"
            class="scm-group-title"
            @contextmenu="openMenu({ provider, group, groupId: gid }, $event)"
            @keydown="openMenu({ provider, group, groupId: gid }, $event)"
            :aria-expanded="!collapsedGroups.has(`${provider.handle}:${gid}`)"
            @click="scm.toggleGroup(provider, gid)"
          >
            <span
              :class="
                collapsedGroups.has(`${provider.handle}:${gid}`)
                  ? 'i-codicon-chevron-right'
                  : 'i-codicon-chevron-down'
              "
              aria-hidden="true"
            />
            <span>{{ group.label }}</span>
            <span class="scm-group-count">{{ group.resources.length }}</span>
          </button>
          <ul v-if="!collapsedGroups.has(`${provider.handle}:${gid}`)" class="scm-resource-list">
            <li
              v-for="(resource, index) in group.resources"
              :key="`${index}:${typeof resource === 'string' ? resource : resource.resourceUri}`"
            >
              <button
                type="button"
                class="scm-resource-item"
                @contextmenu="openMenu({ provider, group, groupId: gid, resource }, $event)"
                @keydown="openMenu({ provider, group, groupId: gid, resource }, $event)"
                :class="{
                  'scm-resource-faded': typeof resource !== 'string' && resource.decorations?.faded,
                  'scm-resource-deleted':
                    typeof resource !== 'string' && resource.decorations?.strikeThrough,
                }"
                :aria-disabled="
                  typeof resource !== 'string' &&
                  !resource.command &&
                  resource.resourceUri.scheme !== 'file'
                "
                :title="
                  typeof resource === 'string'
                    ? resource
                    : (resource.decorations?.tooltip ??
                      resource.command?.tooltip ??
                      resource.resourceUri.path)
                "
                @click="scm.openResource(resource)"
              >
                <span class="scm-resource-name">{{ resourceLabel(resource) }}</span>
                <span
                  v-if="typeof resource === 'string'"
                  class="scm-resource-badge"
                  aria-hidden="true"
                  >M</span
                >
              </button>
            </li>
          </ul>
        </div>
      </template>
    </div>
    <ContextMenu ref="contextMenu" label="Source Control actions" :groups="menuGroups" />
  </section>
</template>

<style scoped>
.changes-panel {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 8px;
  overflow: auto;
}

.changes-empty {
  font-size: 12px;
  color: var(--muted);
  padding: 12px;
}

.scm-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.scm-input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  font-size: 12px;
  margin-bottom: 8px;
}

.scm-group-title {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 2px;
  text-align: left;
}

.scm-group-count {
  margin-left: auto;
  opacity: 0.7;
}

.scm-resource-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.scm-resource-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
  border-radius: 3px;
}

.scm-resource-item:hover:not([aria-disabled="true"]) {
  background: var(--hover);
}

.scm-resource-item:focus-visible {
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}

.scm-resource-item[aria-disabled="true"] {
  cursor: default;
}

.scm-resource-faded .scm-resource-name {
  opacity: 0.65;
}

.scm-resource-deleted .scm-resource-name {
  text-decoration: line-through;
}

.scm-resource-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scm-resource-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--modified);
}
</style>
