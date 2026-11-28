<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; component: SettingsEditor. Adaptation: Search and category navigation for Harness preferences in the dialog and editor. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { Button, IconButton, SelectBox } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { AppearanceSettingsSlot, SettingsSlot, UiWorkbenchService } from "@harness/ui-workbench";

const emit = defineEmits<{ reset: []; sidebarSide: [side: "left" | "right"] }>();
defineProps<{ inDialog?: boolean }>();

const workbench = useService(UiWorkbenchService);
const chat = useService(UiChatManagerService);

const theme = workbench.theme;
const sidebarLocation = workbench.sidebarLocation;
const activityBarLocation = workbench.activityBarLocation;
const modelId = chat.model;

const categories = [
  { id: "appearance", label: "Appearance" },
  { id: "conversations", label: "Conversations" },
  { id: "layout", label: "Layout" },
] as const;
type Category = (typeof categories)[number]["id"];

const resultsId = useId();
const search = ref("");
const searchInput = ref<HTMLInputElement>();
const results = ref<HTMLElement>();
const settingsContent = ref<HTMLElement>();
const category = ref<Category | "all">("all");
const counts = ref<Record<Category, number>>({ appearance: 0, conversations: 0, layout: 0 });
const query = computed(() => search.value.trim().toLowerCase());
const total = computed(() => Object.values(counts.value).reduce((sum, count) => sum + count, 0));
const resultCount = computed(() =>
  category.value === "all" ? total.value : counts.value[category.value],
);
let observer: MutationObserver | undefined;

function refreshMatches() {
  const terms = query.value.split(/\s+/).filter(Boolean);
  const next = { appearance: 0, conversations: 0, layout: 0 };
  for (const { id, label } of categories) {
    const group = settingsContent.value?.querySelector(`[data-settings-category="${id}"]`);
    for (const row of group?.querySelectorAll<HTMLElement>(".setting") ?? []) {
      const description = Array.from(row.querySelectorAll(":scope > :is(strong, span)"))
        .map((part) => part.textContent)
        .join(" ");
      const text = `${label} ${description}`.toLowerCase();
      const matches = terms.every((term) => text.includes(term));
      row.hidden = !matches;
      if (matches) next[id]++;
    }
  }
  counts.value = next;
}

function chooseCategory(next: Category | "all") {
  category.value = next;
  results.value?.scrollTo({ top: 0 });
}

function showCategory(id: Category) {
  return (
    (category.value === "all" || category.value === id) && (!query.value || counts.value[id] > 0)
  );
}

function clearSearch() {
  search.value = "";
  searchInput.value?.focus();
}

watch(query, () => {
  chooseCategory("all");
  refreshMatches();
});

onMounted(() => {
  if (!settingsContent.value) return;
  observer = new MutationObserver(() => {
    if (query.value) refreshMatches();
  });
  observer.observe(settingsContent.value, { childList: true, subtree: true, characterData: true });
});

onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <section class="panel-fill settings-panel" :class="{ 'settings-in-dialog': inDialog }">
    <header class="settings-header">
      <h2 v-if="!inDialog">Settings</h2>
      <div class="settings-search" role="search">
        <span class="i-codicon-search" aria-hidden="true" />
        <input
          ref="searchInput"
          v-model="search"
          type="search"
          aria-label="Search settings"
          :aria-controls="resultsId"
          placeholder="Search settings"
          autocomplete="off"
        />
        <span v-if="query" class="settings-match-count" role="status">
          {{ resultCount }} {{ resultCount === 1 ? "setting" : "settings" }}
        </span>
        <IconButton
          v-if="search"
          icon="i-codicon-close"
          label="Clear search"
          @click="clearSearch"
        />
      </div>
    </header>

    <div class="settings-body">
      <nav class="settings-categories" aria-label="Settings categories">
        <button
          type="button"
          :aria-controls="resultsId"
          :aria-pressed="category === 'all'"
          @click="chooseCategory('all')"
        >
          All settings
        </button>
        <template v-for="item in categories" :key="item.id">
          <button
            v-if="!query || counts[item.id]"
            type="button"
            :aria-controls="resultsId"
            :aria-pressed="category === item.id"
            @click="chooseCategory(item.id)"
          >
            <span>{{ item.label }}</span>
            <span v-if="query" class="settings-category-count">{{ counts[item.id] }}</span>
          </button>
        </template>
      </nav>

      <div
        :id="resultsId"
        ref="results"
        class="settings-scroll"
        role="region"
        aria-label="Settings results"
      >
        <p v-if="query && !resultCount" class="settings-empty">
          No settings match “{{ search.trim() }}”.
        </p>
        <div ref="settingsContent" class="settings-content">
          <section
            :hidden="!showCategory('appearance')"
            class="settings-section"
            data-settings-category="appearance"
          >
            <h3>Appearance</h3>
            <AppearanceSettingsSlot>
              <label class="setting">
                <strong>Color theme</strong>
                <span>Applies across the workbench.</span>
                <SelectBox
                  v-model="theme"
                  aria-label="Color theme"
                  :options="[
                    { label: 'Dark 2026', value: 'dark' },
                    { label: 'Light 2026', value: 'light' },
                  ]"
                />
              </label>
            </AppearanceSettingsSlot>
          </section>

          <section
            :hidden="!showCategory('conversations')"
            class="settings-section"
            data-settings-category="conversations"
          >
            <h3>Conversations</h3>
            <label class="setting">
              <strong>Default model</strong>
              <span>Used for new requests.</span>
              <SelectBox
                v-model="modelId"
                aria-label="Default model"
                :options="chat.models.value.map((item) => ({ label: item.name, value: item.id }))"
              />
            </label>
          </section>

          <section
            :hidden="!showCategory('layout')"
            class="settings-section"
            data-settings-category="layout"
          >
            <h3>Layout</h3>
            <label class="setting">
              <strong>Primary sidebar</strong>
              <span>The activity bar moves with it.</span>
              <SelectBox
                :model-value="sidebarLocation"
                aria-label="Primary sidebar"
                :options="[
                  { label: 'Left', value: 'left' },
                  { label: 'Right', value: 'right' },
                ]"
                @update:model-value="emit('sidebarSide', $event as 'left' | 'right')"
              />
            </label>
            <label class="setting">
              <strong>Activity Bar Position</strong>
              <span
                >Place view icons beside the sidebar (Default), at its top or bottom, or hide
                them.</span
              >
              <SelectBox
                v-model="activityBarLocation"
                aria-label="Activity Bar Position"
                :options="[
                  { label: 'Default', value: 'default' },
                  { label: 'Top', value: 'top' },
                  { label: 'Bottom', value: 'bottom' },
                  { label: 'Hidden', value: 'hidden' },
                ]"
              />
            </label>
            <div class="setting">
              <strong>Workbench layout</strong>
              <span>Reset view placement and sizing.</span>
              <Button variant="secondary" @click="emit('reset')">Restore default layout</Button>
            </div>
          </section>
          <div v-show="category === 'all' && !query">
            <SettingsSlot />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-panel {
  container: settings / inline-size;
  --settings-gutter: clamp(10px, 4.2cqi, 24px);
  --settings-input-surface: color-mix(in srgb, var(--input), var(--fg) 6%);
}

.settings-in-dialog {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}

.settings-header {
  flex: none;
  padding: 14px var(--settings-gutter) 12px;
  border-bottom: 1px solid var(--border);
}

.settings-header > h2 {
  margin: 0 0 12px;
  color: var(--strong);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.25;
}

.settings-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  background: var(--settings-input-surface);
  color: var(--muted);
}

.settings-search:focus-within {
  border-color: var(--selection-border);
}

.settings-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--fg);
}

.settings-search input::-webkit-search-cancel-button {
  display: none;
}

.settings-match-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.settings-body {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  padding-block-start: 14px;
  padding-inline-start: var(--settings-gutter);
}

.settings-categories {
  display: flex;
  flex-direction: column;
  padding: 0 8px 10px 0;
  overflow: auto;
  border-inline-end: 1px solid var(--border);
}

.settings-categories button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 22px;
  padding: 0 8px;
  border-radius: 3px;
  color: var(--muted);
  text-align: start;
}

.settings-categories button:hover {
  background: var(--hover);
  color: var(--strong);
}

.settings-categories button[aria-pressed="true"] {
  background: var(--selected);
  color: var(--strong);
  font-weight: 600;
}

.settings-category-count {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.settings-scroll {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.settings-content {
  padding: 0 var(--settings-gutter) 20px;
}

.settings-empty {
  margin: 0;
  padding: 18px var(--settings-gutter);
  color: var(--muted);
  overflow-wrap: anywhere;
}

.settings-section:not([hidden]) ~ .settings-section:not([hidden]) {
  margin-top: 12px;
}

.settings-section > h3 {
  margin: 0 0 3px;
  padding-inline: 12px;
  color: var(--strong);
  font-size: 17px;
  line-height: 24px;
  font-weight: 600;
}

.settings-panel :deep(.setting) {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 2px;
  padding: 8px 12px 10px;
  border-radius: 4px;
  line-height: 1.4;
}

.settings-panel :deep(.setting[hidden]) {
  display: none;
}

.settings-panel :deep(.setting:hover),
.settings-panel :deep(.setting:has(> :focus-visible, > [data-state="open"])) {
  background: color-mix(in srgb, var(--hover) 55%, transparent);
}

.settings-panel :deep(.setting > strong) {
  color: var(--strong);
  font-size: 13px;
  font-weight: 600;
}

.settings-panel :deep(.setting > span) {
  color: var(--muted);
  font-size: 13px;
}

.settings-panel :deep(.setting > :is(button, select)) {
  justify-self: start;
  width: min(100%, 300px);
  min-width: 0;
  margin-top: 6px;
}

.settings-panel :deep(.setting > .select-box:not(:disabled)) {
  background: var(--settings-input-surface);
}

.settings-panel :deep(.setting > .select-box) {
  height: 26px;
  padding-block: 0;
}

.settings-panel :deep(.setting > .secondary-button) {
  width: fit-content;
  max-width: 100%;
  min-height: 26px;
  padding: 3px 9px;
  border: 1px solid var(--control-border);
  border-radius: 3px;
  background: var(--input);
  line-height: 1.4;
}

.settings-panel :deep(.setting > .secondary-button:hover) {
  background: var(--hover);
  color: var(--strong);
}

@container settings (width < 580px) {
  .settings-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    padding: 0;
  }

  .settings-categories {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 2px;
    padding: 6px var(--settings-gutter);
    border-inline-end: 0;
    border-bottom: 1px solid var(--border);
  }

  .settings-categories button {
    height: 26px;
    white-space: nowrap;
  }

  .settings-content {
    padding-top: 12px;
  }
}
</style>
