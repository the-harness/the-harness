<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: QuickInputShell, QuickPick, Breadcrumbs, Button, IconButton
  Adaptation: Unified file and directory picker modal with live path navigation, breadcrumbs, hidden-entry toggle, and inline folder creation.
-->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { Button, ContextMenu, IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import type { FilePickerEntry, FilePickerListing } from "./contract.ts";
import { UiFilePickerService, type FilePickerSession, type FilePickerMenuContext } from "./service.ts";

const picker = useService(UiFilePickerService);
const session = picker.activeSession;

const isOpen = computed({
  get: () => session.value !== null,
  set: (value: boolean) => {
    if (!value && session.value) {
      session.value.resolve(undefined);
    }
  },
});

const listing = ref<FilePickerListing | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const pathInput = ref("");
const includeHidden = ref(false);
const activeIndex = ref(0);
const selectedPaths = ref<string[]>([]);
const fileName = ref("");
const filterIndex = ref(0);
const saving = ref(false);
const creatingFolder = ref(false);
const newFolderName = ref("");
const newFolderError = ref("");

const pathInputRef = ref<HTMLInputElement>();
const newFolderInputRef = ref<HTMLInputElement>();
const nameInputRef = ref<HTMLInputElement>();
const listRef = ref<HTMLElement>();

let requestSeq = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;

const currentPath = computed(() => listing.value?.path ?? "");
const homePath = computed(() => listing.value?.home ?? "");
const sep = computed(() => listing.value?.separator ?? "/");
const filters = computed(() => Object.entries(session.value?.filters ?? {}));
const extensions = computed(() => filters.value[filterIndex.value]?.[1] ?? []);
const canConfirm = computed(() => {
  if (loading.value) return false;
  switch (session.value?.mode) {
    case "save":
      return !saving.value && !!currentPath.value && !!fileName.value.trim();
    case "directory":
      return !!currentPath.value;
    default:
      return selectedPaths.value.length > 0;
  }
});

function matchesFilter(entry: FilePickerEntry): boolean {
  if (entry.type === "directory" || extensions.value.length === 0) return true;
  const name = entry.name.toLowerCase();
  return extensions.value.some(
    (extension) => extension === "*" || name.endsWith(`.${extension.toLowerCase()}`),
  );
}

function canSelectEntry(entry: FilePickerEntry, current: FilePickerSession): boolean {
  if (current.mode === "save") return false;
  return entry.type === "directory"
    ? current.mode !== "file" && !!current.selectDirectoryRows
    : current.mode !== "directory";
}

function formatDisplayPath(fullPath: string): string {
  const home = homePath.value;
  if (home && (fullPath === home || fullPath.startsWith(`${home}${sep.value}`))) {
    return `~${fullPath.slice(home.length)}`;
  }
  return fullPath;
}

const breadcrumbs = computed(() => {
  const full = currentPath.value;
  if (!full) return [];
  const home = homePath.value;
  const s = sep.value;
  const items: { label: string; path: string }[] = [];

  if (home && (full === home || full.startsWith(`${home}${s}`))) {
    items.push({ label: "~", path: home });
    const rest = full.slice(home.length).split(s).filter(Boolean);
    let acc = home;
    for (const part of rest) {
      acc = acc.endsWith(s) ? `${acc}${part}` : `${acc}${s}${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }

  const parts = full.split(s).filter(Boolean);
  if (full.startsWith(s)) {
    items.push({ label: s, path: s });
  }
  let acc = full.startsWith(s) ? "" : "";
  for (const part of parts) {
    acc = acc ? `${acc}${s}${part}` : full.startsWith(s) ? `${s}${part}` : part;
    items.push({ label: part, path: acc });
  }
  return items;
});

const filterFragment = computed(() => {
  const raw = pathInput.value.trim();
  const committed = formatDisplayPath(currentPath.value);
  if (!raw || raw === committed || raw === `${committed}${sep.value}`) {
    return "";
  }
  const s = sep.value;
  const lastSep = raw.lastIndexOf(s);
  if (lastSep !== -1) {
    return raw.slice(lastSep + 1);
  }
  return raw;
});

interface RowItem {
  readonly kind: "parent" | "entry";
  readonly label: string;
  readonly entry?: FilePickerEntry;
}

const rows = computed<RowItem[]>(() => {
  const result: RowItem[] = [];
  if (listing.value?.parent && !filterFragment.value) {
    result.push({ kind: "parent", label: ".." });
  }
  const q = filterFragment.value.toLowerCase();
  for (const entry of listing.value?.entries ?? []) {
    if (!matchesFilter(entry)) continue;
    if (q && !entry.name.toLowerCase().includes(q)) continue;
    result.push({ kind: "entry", label: entry.name, entry });
  }
  return result;
});

watch(rows, (list) => {
  if (activeIndex.value >= list.length) {
    activeIndex.value = Math.max(0, list.length - 1);
  }
});

watch(filterIndex, () => {
  const allowed = new Set(listing.value?.entries.filter(matchesFilter).map((entry) => entry.path));
  selectedPaths.value = selectedPaths.value.filter((path) => allowed.has(path));
});

async function loadDirectory(targetPath?: string, syncInput = true, initialName?: string) {
  const currentSession = session.value;
  if (!currentSession) return;

  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await picker.list({
      path: targetPath,
      includeFiles: currentSession.mode !== "directory",
      includeHidden: includeHidden.value,
    });
    if (seq !== requestSeq || session.value !== currentSession) return;
    if (listing.value?.path !== res.path) selectedPaths.value = [];
    listing.value = res;
    if (initialName) {
      const initial = res.entries.find((entry) => entry.name === initialName);
      if (initial && canSelectEntry(initial, currentSession) && matchesFilter(initial))
        selectedPaths.value = [initial.path];
    }
    activeIndex.value = 0;
    if (syncInput) {
      pathInput.value = formatDisplayPath(res.path);
    }
  } catch (err) {
    if (seq !== requestSeq || session.value !== currentSession) return;
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === requestSeq && session.value === currentSession) {
      loading.value = false;
    }
  }
}

watch(
  session,
  (next) => {
    clearTimeout(draftTimer);
    creatingFolder.value = false;
    newFolderName.value = "";
    newFolderError.value = "";
    listing.value = null;
    selectedPaths.value = [];
    pathInput.value = next?.initialPath ?? "";
    fileName.value = next?.initialName ?? "";
    filterIndex.value = 0;
    saving.value = false;
    if (!next) {
      loading.value = false;
      errorMessage.value = "";
      return;
    }
    void loadDirectory(next.initialPath, true, next.initialName);
  },
  { immediate: true },
);

function onOpenAutoFocus(event: Event) {
  event.preventDefault();
  const input = session.value?.mode === "save" ? nameInputRef.value : pathInputRef.value;
  input?.focus();
  input?.select();
}

watch(includeHidden, () => {
  if (session.value && currentPath.value) {
    void loadDirectory(currentPath.value, false);
  }
});

function onPathInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  pathInput.value = value;
  clearTimeout(draftTimer);

  const s = sep.value;
  const trimmed = value.trim();
  const isPathLike =
    trimmed.startsWith(s) || trimmed.startsWith("~") || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isPathLike) return;

  const lastSep = trimmed.lastIndexOf(s);
  const dirPart = lastSep > 0 ? trimmed.slice(0, lastSep) : trimmed === "~" ? "~" : s;
  if (!dirPart) return;

  draftTimer = setTimeout(() => {
    void loadDirectory(dirPart, false);
  }, 180);
}

function moveActive(delta: number) {
  if (!rows.value.length) return;
  activeIndex.value = (activeIndex.value + delta + rows.value.length) % rows.value.length;
  void nextTick(() => {
    listRef.value
      ?.querySelector<HTMLElement>(`[data-row-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function activateRow(row: RowItem) {
  if (row.kind === "parent") {
    if (listing.value?.parent) {
      void loadDirectory(listing.value.parent, true);
    }
    return;
  }
  const entry = row.entry;
  if (!entry) return;
  if (entry.type === "directory") {
    void loadDirectory(entry.path, true);
    return;
  }
  const current = session.value;
  if (!current) return;
  if (current.mode === "save") {
    fileName.value = entry.name;
    void confirmSelection();
  } else if (current.multiple) {
    if (!selectedPaths.value.includes(entry.path)) selectedPaths.value.push(entry.path);
    void confirmSelection();
  } else if (canSelectEntry(entry, current)) {
    current.resolve([entry.path]);
  }
}

function onRowClick(row: RowItem, index: number) {
  activeIndex.value = index;
  if (row.kind === "parent") {
    if (listing.value?.parent) {
      void loadDirectory(listing.value.parent, true);
    }
    return;
  }
  const entry = row.entry;
  const current = session.value;
  if (!entry || !current) return;
  if (entry.type === "directory" && !canSelectEntry(entry, current)) {
    void loadDirectory(entry.path, true);
    return;
  }
  if (current.mode === "save") {
    fileName.value = entry.name;
    return;
  }
  if (!canSelectEntry(entry, current)) return;
  if (!current.multiple) selectedPaths.value = [entry.path];
  else if (selectedPaths.value.includes(entry.path))
    selectedPaths.value = selectedPaths.value.filter((path) => path !== entry.path);
  else selectedPaths.value.push(entry.path);
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
    return;
  }
  if (event.key === "Tab" && !event.shiftKey) {
    const row = rows.value[activeIndex.value];
    if (row?.kind === "entry" && row.entry?.type === "directory") {
      event.preventDefault();
      void loadDirectory(row.entry.path, true);
    }
    return;
  }
  if (event.key === "Backspace") {
    const input = pathInputRef.value;
    const committed = formatDisplayPath(currentPath.value);
    if (
      input &&
      pathInput.value === committed &&
      input.selectionStart === committed.length &&
      input.selectionEnd === committed.length &&
      listing.value?.parent
    ) {
      event.preventDefault();
      void loadDirectory(listing.value.parent, true);
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const row = rows.value[activeIndex.value];
    if (row && (filterFragment.value || row.kind === "entry")) {
      activateRow(row);
      return;
    }
    void confirmSelection();
  }
}

async function confirmSelection() {
  const currentSession = session.value;
  if (!currentSession || !canConfirm.value) return;
  if (currentSession.mode !== "save") {
    currentSession.resolve(selectedPaths.value.length ? selectedPaths.value : [currentPath.value]);
    return;
  }
  const name = fileName.value.trim();
  const directory = currentPath.value;
  const filter = filterIndex.value;
  const suffix = extensions.value[0];
  const target = !name.includes(".") && suffix && suffix !== "*" ? `${name}.${suffix}` : name;
  saving.value = true;
  errorMessage.value = "";
  try {
    const { path, exists } = await picker.resolveSavePath(directory, target);
    if (
      session.value !== currentSession ||
      currentPath.value !== directory ||
      fileName.value.trim() !== name ||
      filterIndex.value !== filter
    )
      return;
    if (!exists || window.confirm(`Replace ${target}?`)) currentSession.resolve([path]);
  } catch (error) {
    if (session.value === currentSession)
      errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (session.value === currentSession) saving.value = false;
  }
}

async function openCreateFolder() {
  creatingFolder.value = true;
  newFolderName.value = "";
  newFolderError.value = "";
  await nextTick();
  newFolderInputRef.value?.focus();
}

async function submitCreateFolder() {
  const name = newFolderName.value.trim();
  if (!name) {
    newFolderError.value = "A folder name must be provided.";
    return;
  }
  if (!currentPath.value) return;
  try {
    const createdPath = await picker.createDirectory(currentPath.value, name);
    creatingFolder.value = false;
    newFolderName.value = "";
    newFolderError.value = "";
    await loadDirectory(createdPath, true);
  } catch (err) {
    newFolderError.value = err instanceof Error ? err.message : String(err);
  }
}

const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuTarget = shallowRef<{ session: FilePickerSession; context: Pick<FilePickerMenuContext, "directory" | "path"> }>();
const menuGroups = computed(() => {
  const target = menuTarget.value;
  if (!target || target.session !== session.value || target.context.directory !== currentPath.value || loading.value) return [];
  const { directory, path } = target.context;
  const index = path === undefined ? -1 : rows.value.findIndex((row) => row.entry?.path === path);
  const row = rows.value[index];
  if (path !== undefined && !row) return [];
  return picker.menu.resolve({
    directory, path,
    directoryEntry: row?.entry?.type === "directory",
    selectable: !!row?.entry && canSelectEntry(row.entry, target.session),
    selected: path !== undefined && selectedPaths.value.includes(path),
    multiple: !!target.session.multiple,
    includeHidden: includeHidden.value,
    open: () => { if (row) activateRow(row); },
    select: () => { if (row) onRowClick(row, index); },
    createFolder: openCreateFolder,
    refresh: () => loadDirectory(directory, false),
    toggleHidden: () => { includeHidden.value = !includeHidden.value; },
  });
});

async function openMenu(row: RowItem | undefined, event: MouseEvent | KeyboardEvent) {
  if (!session.value || loading.value || event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  menuTarget.value = { session: session.value, context: { directory: currentPath.value, path: row?.entry?.path } };
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

function cancelCreateFolder() {
  creatingFolder.value = false;
  newFolderName.value = "";
  newFolderError.value = "";
  void nextTick(() => pathInputRef.value?.focus());
}
</script>

<template>
  <DialogRoot v-model:open="isOpen">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="fp-dialog" @open-auto-focus="onOpenAutoFocus">
        <DialogTitle class="sr-only">{{ session?.title ?? "Select" }}</DialogTitle>
        <DialogDescription class="sr-only">
          Browse directories and select a path.
        </DialogDescription>

        <header class="fp-header">
          <span class="fp-title">{{ session?.title }}</span>
          <div class="fp-header-actions">
            <IconButton icon="i-codicon-new-folder" label="New Folder" @click="openCreateFolder" />
            <IconButton
              :icon="includeHidden ? 'i-codicon-eye' : 'i-codicon-eye-closed'"
              :label="includeHidden ? 'Hide hidden files' : 'Show hidden files'"
              :active="includeHidden"
              @click="includeHidden = !includeHidden"
            />
            <IconButton icon="i-codicon-close" label="Close" @click="session?.resolve(undefined)" />
          </div>
        </header>

        <div class="fp-pathbar">
          <input
            ref="pathInputRef"
            :value="pathInput"
            type="text"
            class="fp-path-input"
            role="combobox"
            aria-expanded="true"
            aria-label="Path"
            placeholder="Type a path or filter..."
            spellcheck="false"
            autocomplete="off"
            @input="onPathInput"
            @keydown="onInputKeydown"
          />
        </div>

        <nav v-if="breadcrumbs.length" class="fp-breadcrumbs" aria-label="Path breadcrumbs">
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <span
              v-if="index > 0"
              class="fp-crumb-sep i-codicon-chevron-right"
              aria-hidden="true"
            />
            <button type="button" class="fp-crumb" @click="loadDirectory(crumb.path, true)">
              {{ crumb.label }}
            </button>
          </template>
        </nav>

        <form v-if="creatingFolder" class="fp-create-bar" @submit.prevent="submitCreateFolder">
          <input
            ref="newFolderInputRef"
            v-model="newFolderName"
            type="text"
            class="fp-path-input flex-1"
            aria-label="New folder name"
            placeholder="New folder name"
            spellcheck="false"
            autocomplete="off"
            @keydown.esc.prevent.stop="cancelCreateFolder"
          />
          <Button type="submit" variant="primary">Create</Button>
          <Button type="button" variant="secondary" @click="cancelCreateFolder">Cancel</Button>
        </form>
        <div v-if="newFolderError" class="fp-error">{{ newFolderError }}</div>
        <div v-if="errorMessage" class="fp-error">{{ errorMessage }}</div>

        <div
          ref="listRef"
          class="fp-list"
          tabindex="-1"
          @contextmenu="openMenu(undefined, $event)"
          @keydown="openMenu(undefined, $event)"
          role="listbox"
          :aria-busy="loading"
          :aria-multiselectable="session?.multiple || undefined"
        >
          <button
            v-for="(row, index) in rows"
            :key="row.kind === 'parent' ? '..' : row.entry!.path"
            :data-row-index="index"
            type="button"
            role="option"
            class="fp-row"
            @contextmenu="openMenu(row, $event)"
            @keydown="openMenu(row, $event)"
            :class="{
              active: index === activeIndex,
              selected: !!row.entry && selectedPaths.includes(row.entry.path),
            }"
            :aria-selected="!!row.entry && selectedPaths.includes(row.entry.path)"
            @click="onRowClick(row, index)"
            @dblclick="activateRow(row)"
          >
            <span
              class="fp-row-icon"
              :class="
                row.kind === 'parent'
                  ? 'i-codicon-arrow-up'
                  : row.entry?.type === 'directory'
                    ? 'i-codicon-folder'
                    : 'i-codicon-file'
              "
              aria-hidden="true"
            />
            <span class="fp-row-label">{{ row.label }}</span>
          </button>
          <p v-if="!loading && rows.length === 0" class="fp-empty">No matching entries.</p>
        </div>

        <form
          v-if="session?.mode === 'save'"
          class="fp-create-bar"
          @submit.prevent="confirmSelection"
        >
          <input
            ref="nameInputRef"
            v-model="fileName"
            type="text"
            class="fp-path-input"
            aria-label="File name"
            placeholder="File name"
            spellcheck="false"
            autocomplete="off"
          />
        </form>
        <footer class="fp-footer">
          <span v-if="listing?.truncated" class="fp-truncated">Showing first 1000 entries</span>
          <select
            v-if="filters.length"
            v-model="filterIndex"
            class="fp-filter"
            aria-label="File type"
          >
            <option v-for="([label], index) in filters" :key="label" :value="index">
              {{ label }}
            </option>
          </select>
          <span class="spacer" />
          <Button variant="secondary" @click="session?.resolve(undefined)">Cancel</Button>
          <Button variant="primary" :disabled="!canConfirm" @click="confirmSelection">
            {{ session?.confirmLabel ?? "Select" }}
          </Button>
        </footer>
        <ContextMenu ref="contextMenu" label="File picker actions" :groups="menuGroups"
          :on-error="(error) => { errorMessage = error instanceof Error ? error.message : String(error); }" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.fp-dialog {
  position: fixed;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  width: min(600px, calc(100vw - 32px));
  max-height: min(520px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  background: var(--raised);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 32px var(--shadow);
  z-index: 2600;
  overflow: hidden;
}
.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 6px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.fp-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--strong);
}
.fp-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.fp-pathbar {
  padding: 8px 10px 6px;
}
.fp-path-input {
  width: 100%;
  height: 26px;
  padding: 4px 8px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  background: var(--input);
  color: var(--strong);
  border: 1px solid var(--control-border);
  border-radius: 4px;
}
.fp-path-input:focus {
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}
.fp-breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 0 10px 6px;
  font-size: 11px;
  color: var(--muted);
}
.fp-crumb {
  padding: 1px 4px;
  border-radius: 3px;
}
.fp-crumb:hover {
  background: var(--hover);
  color: var(--strong);
}
.fp-crumb-sep {
  font-size: 10px;
  opacity: 0.6;
}
.fp-create-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 6px;
}
.fp-filter {
  min-width: 0;
  background: var(--input);
  border: 1px solid var(--control-border);
  color: var(--fg);
  border-radius: 3px;
  padding: 3px 6px;
}
.fp-error {
  margin: 0 10px 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--error-bg);
  color: var(--error-fg);
  border: 1px solid var(--error-border);
  border-radius: 3px;
}
.fp-list {
  flex: 1;
  min-height: 180px;
  overflow: auto;
  padding: 2px 6px 6px;
}
.fp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: 3px;
  text-align: left;
  font-size: 13px;
}
.fp-row:hover {
  background: var(--hover);
}
.fp-row.active {
  background: var(--selected);
  color: var(--strong);
}
.fp-row.selected {
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}
.fp-row-icon {
  font-size: 15px;
  color: var(--muted);
  flex-shrink: 0;
}
.fp-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
.fp-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.fp-truncated {
  font-size: 11px;
  color: var(--muted);
}
</style>
