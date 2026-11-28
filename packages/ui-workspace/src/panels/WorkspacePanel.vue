<!--
  UI reference skill: vscode-ui
  Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
  Reference components: SettingsEditor, SettingsRow, InputBox, ActionBar, Button
  Adaptation: Workspace configuration editor adapting VS Code SettingsEditor row geometry, focus navigation, and setting-list-widget inline add/edit/remove behavior for multi-folder workspaces and instructions.
-->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { Button, ContextMenu, IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { TabContext } from "@harness/ui-workbench";
import { UiWorkspaceService, type WorkspaceFolderMenuContext } from "@harness/ui-workspace";
import type { WorkspaceTabDescriptor } from "../tabs/WorkspaceTab.ts";

const workspaceService = useService(UiWorkspaceService);
const filePicker = useService(UiFilePickerService);

let tabContext: TabContext<WorkspaceTabDescriptor> | undefined;
try {
  tabContext = useService(TabContext) as TabContext<WorkspaceTabDescriptor>;
} catch {
  tabContext = undefined;
}

const workspaceId = computed(
  () => tabContext?.descriptor.workspaceId ?? workspaceService.activeWorkspaceId.value,
);

const workspace = computed(
  () => workspaceService.getWorkspace(workspaceId.value) ?? workspaceService.currentWorkspace.value,
);

const folderRows = computed(() => {
  const ws = workspace.value;
  if (!ws) return [];
  const pathCounts = new Map<string, number>();
  for (const folder of ws.folders) {
    pathCounts.set(folder, (pathCounts.get(folder) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return ws.folders.map((folder) => {
    const occurrence = occurrences.get(folder) ?? 0;
    occurrences.set(folder, occurrence + 1);
    // When a duplicate disappears, its former occurrence may now refer to a different row.
    return { folder, key: JSON.stringify([ws.id, folder, pathCounts.get(folder), occurrence]) };
  });
});

const editorRoot = ref<HTMLElement>();
const nameRow = ref<HTMLElement>();
const foldersRow = ref<HTMLElement>();
const instructionsRow = ref<HTMLElement>();

const focusedKey = ref<string>("");
const hoveredKey = ref<string>("");

const nameDraft = ref("");
const nameError = ref("");

const selectedFolderKey = ref<string | null>(null);
const editingFolderKey = ref<string | null>(null);
const addingFolder = ref(false);
const folderDraft = ref("");
const folderError = ref("");
const folderEditInput = ref<HTMLInputElement>();
const folderAddInput = ref<HTMLInputElement>();
const addButtonWrap = ref<HTMLElement>();
const folderMenu = ref<InstanceType<typeof ContextMenu>>();
const folderMenuTarget = shallowRef<{ context: Pick<WorkspaceFolderMenuContext, "workspaceId" | "folder">; key?: string }>();
const folderMenuGroups = computed(() => {
  const target = folderMenuTarget.value;
  if (!target || target.context.workspaceId !== workspace.value?.id) return [];
  const index = folderRows.value.findIndex(({ key }) => key === target.key);
  if (target.key !== undefined && index < 0) return [];
  return workspaceService.folderMenu.resolve({
    ...target.context,
    edit: () => startEditFolder(index),
    remove: () => removeFolder(target.context.folder!, index),
    browse: browseFolder,
    add: startAddFolder,
  });
});

async function openFolderMenu(key: string | undefined, event: MouseEvent | KeyboardEvent) {
  if (!workspace.value || event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  const row = folderRows.value.find((row) => row.key === key);
  folderMenuTarget.value = {
    context: { workspaceId: workspace.value.id, folder: row?.folder }, key,
  };
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  folderMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

function setRowFocus(key: string) {
  focusedKey.value = key;
  if (key !== "workspace.folders") {
    selectedFolderKey.value = null;
  }
}

function handleRowFocusOut(key: string, rowEl: HTMLElement | undefined, event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (next && rowEl?.contains(next)) {
    return;
  }
  void nextTick(() => {
    const active = document.activeElement;
    if (active && rowEl?.contains(active)) {
      return;
    }
    if (focusedKey.value === key) {
      focusedKey.value = "";
    }
    if (key === "workspace.folders" && !addingFolder.value && editingFolderKey.value === null) {
      selectedFolderKey.value = null;
    }
  });
}

function onEditorMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".vs-setting-item")) {
    focusedKey.value = "";
    selectedFolderKey.value = null;
    if (
      document.activeElement instanceof HTMLElement &&
      editorRoot.value?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  }
}

watch(
  () => workspace.value?.id,
  (id) => {
    if (id) workspaceService.activeWorkspaceId.value = id;
    selectedFolderKey.value = null;
    clearFolderEdit();
  },
  { immediate: true },
);

watch(
  folderRows,
  (rows) => {
    if (!rows.some(({ key }) => key === selectedFolderKey.value)) selectedFolderKey.value = null;
    if (
      editingFolderKey.value !== null &&
      !rows.some(({ key }) => key === editingFolderKey.value)
    ) {
      clearFolderEdit();
    }
  },
  { flush: "sync" },
);

watch(
  () => workspace.value?.name,
  (next) => {
    nameDraft.value = next ?? "";
    nameError.value = "";
  },
  { immediate: true },
);

function onNameInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  nameDraft.value = value;
  const trimmed = value.trim();
  if (!trimmed) {
    nameError.value = "A workspace name must be provided.";
    return;
  }
  nameError.value = "";
  const ws = workspace.value;
  if (ws && trimmed !== ws.name) {
    workspaceService.renameWorkspace(ws.id, trimmed);
  }
}

function onNameBlur() {
  const ws = workspace.value;
  if (!ws) return;
  if (!nameDraft.value.trim()) {
    nameDraft.value = ws.name;
    nameError.value = "";
  }
}

function focusFolderRow(index: number) {
  const key = folderRows.value[index]?.key;
  void nextTick(() => {
    const rows = foldersRow.value?.querySelectorAll<HTMLElement>("[data-folder-key]") ?? [];
    const target = Array.from(rows).find((row) => row.dataset.folderKey === key);
    if (target && key !== undefined) {
      target.focus();
      selectedFolderKey.value = key;
      return;
    }
    addButtonWrap.value?.querySelector<HTMLElement>("button")?.focus();
  });
}

async function browseFolder() {
  const ws = workspace.value;
  if (!ws) return;
  const picked = await filePicker.pickFolder({
    title: "Add Folder to Workspace",
    initialPath: ws.folders[0],
  });
  if (!picked) return;
  if (workspaceService.addFolder(ws.id, picked)) {
    focusFolderRow(ws.folders.length);
  }
}

async function startAddFolder() {
  editingFolderKey.value = null;
  addingFolder.value = true;
  folderDraft.value = "";
  folderError.value = "";
  focusedKey.value = "workspace.folders";
  await nextTick();
  folderAddInput.value?.focus();
}

async function startEditFolder(index: number) {
  const row = folderRows.value[index];
  if (!row) return;
  addingFolder.value = false;
  editingFolderKey.value = row.key;
  selectedFolderKey.value = row.key;
  folderDraft.value = row.folder;
  folderError.value = "";
  focusedKey.value = "workspace.folders";
  await nextTick();
  const inputEl = Array.isArray(folderEditInput.value)
    ? folderEditInput.value[0]
    : folderEditInput.value;
  inputEl?.focus();
  inputEl?.select();
}

function clearFolderEdit() {
  addingFolder.value = false;
  editingFolderKey.value = null;
  folderDraft.value = "";
  folderError.value = "";
}

function cancelFolderEdit(restoreIndex?: number) {
  clearFolderEdit();
  if (restoreIndex !== undefined) {
    focusFolderRow(restoreIndex);
  } else {
    void nextTick(() => {
      addButtonWrap.value?.querySelector<HTMLElement>("button")?.focus();
    });
  }
}

function commitAddFolder() {
  const ws = workspace.value;
  if (!ws) return;
  const trimmed = folderDraft.value.trim();
  if (!trimmed) {
    folderError.value = "A folder path must be provided.";
    return;
  }
  if (ws.folders.includes(trimmed)) {
    folderError.value = "This folder is already in the workspace.";
    return;
  }
  workspaceService.addFolder(ws.id, trimmed);
  const newIndex = ws.folders.length;
  clearFolderEdit();
  focusFolderRow(newIndex);
}

function commitEditFolder() {
  const ws = workspace.value;
  if (!ws || editingFolderKey.value === null) return;
  const index = folderRows.value.findIndex(({ key }) => key === editingFolderKey.value);
  if (index === -1) return;
  const trimmed = folderDraft.value.trim();
  if (!trimmed) {
    folderError.value = "A folder path must be provided.";
    return;
  }
  if (ws.folders.some((item, idx) => idx !== index && item === trimmed)) {
    folderError.value = "This folder is already in the workspace.";
    return;
  }
  workspaceService.updateFolder(ws.id, index, trimmed);
  clearFolderEdit();
  focusFolderRow(index);
}

function removeFolder(folder: string, index: number) {
  const ws = workspace.value;
  if (!ws) return;
  workspaceService.removeFolder(ws.id, folder);
  const remainingCount = folderRows.value.length;
  if (remainingCount > 0) {
    focusFolderRow(Math.min(index, remainingCount - 1));
  } else {
    selectedFolderKey.value = null;
    void nextTick(() => {
      addButtonWrap.value?.querySelector<HTMLElement>("button")?.focus();
    });
  }
}

function onFolderRowKeydown(index: number, folder: string, event: KeyboardEvent) {
  const ws = workspace.value;
  if (!ws) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (index + 1 < ws.folders.length) {
      focusFolderRow(index + 1);
    }
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (index - 1 >= 0) {
      focusFolderRow(index - 1);
    }
    return;
  }
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault();
    void startEditFolder(index);
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeFolder(folder, index);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    selectedFolderKey.value = null;
    (event.currentTarget as HTMLElement | null)?.blur();
  }
}

function updateInstructions(event: Event) {
  const ws = workspace.value;
  if (!ws) return;
  workspaceService.updateInstructions(ws.id, (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <section
    ref="editorRoot"
    class="panel-fill vs-settings-editor"
    aria-label="Workspace settings"
    @mousedown="onEditorMouseDown"
  >
    <div v-if="workspace" class="vs-settings-scroll">
      <div class="vs-settings-tree-container">
        <div
          ref="nameRow"
          class="vs-setting-item vs-setting-item-text"
          :class="{
            'invalid-input': !!nameError,
            focused: focusedKey === 'workspace.name',
            mouseover: hoveredKey === 'workspace.name',
          }"
          @mousedown="setRowFocus('workspace.name')"
          @focusin="setRowFocus('workspace.name')"
          @focusout="handleRowFocusOut('workspace.name', nameRow, $event)"
          @mouseenter="hoveredKey = 'workspace.name'"
          @mouseleave="hoveredKey === 'workspace.name' && (hoveredKey = '')"
        >
          <div class="vs-setting-title">
            <span class="vs-setting-category">Workspace: </span>
            <span class="vs-setting-label">Name</span>
          </div>
          <div class="vs-setting-description">
            The display name of this workspace shown in the Conversations tree and editor tab.
          </div>
          <div class="vs-setting-value">
            <div class="vs-setting-control vs-setting-control-text" @mousedown.stop>
              <input
                :value="nameDraft"
                type="text"
                class="vs-input"
                :class="{ invalid: !!nameError }"
                aria-label="Workspace name"
                spellcheck="false"
                autocomplete="off"
                @focus="setRowFocus('workspace.name')"
                @input="onNameInput"
                @blur="onNameBlur"
              />
              <div v-if="nameError" class="vs-validation-message" role="status">
                {{ nameError }}
              </div>
            </div>
          </div>
        </div>

        <div
          ref="foldersRow"
          class="vs-setting-item vs-setting-item-list"
          :class="{
            'invalid-input': !!folderError,
            focused: focusedKey === 'workspace.folders',
            mouseover: hoveredKey === 'workspace.folders',
          }"
          @mousedown="setRowFocus('workspace.folders')"
          @focusin="setRowFocus('workspace.folders')"
          @focusout="handleRowFocusOut('workspace.folders', foldersRow, $event)"
          @mouseenter="hoveredKey = 'workspace.folders'"
          @mouseleave="hoveredKey === 'workspace.folders' && (hoveredKey = '')"
        >
          <div class="vs-setting-title">
            <span class="vs-setting-category">Workspace: </span>
            <span class="vs-setting-label">Folders</span>
          </div>
          <div class="vs-setting-description">
            Folders included in this workspace. The first folder is used as the primary working
            directory for relative paths and shell commands.
          </div>
          <div class="vs-setting-value">
            <div class="vs-setting-control vs-setting-control-list" @mousedown.stop>
              <div class="vs-setting-list-widget" role="list" aria-label="Workspace folders"
                @contextmenu="openFolderMenu(undefined, $event)">
                <template v-for="({ folder, key }, index) in folderRows" :key="key">
                  <form
                    v-if="editingFolderKey === key"
                    class="vs-setting-list-edit-row"
                    @submit.prevent="commitEditFolder"
                  >
                    <input
                      ref="folderEditInput"
                      v-model="folderDraft"
                      type="text"
                      class="vs-input vs-setting-list-input"
                      :class="{ invalid: !!folderError }"
                      aria-label="Edit folder path"
                      spellcheck="false"
                      autocomplete="off"
                      @focus="setRowFocus('workspace.folders')"
                      @keydown.esc.prevent.stop="cancelFolderEdit(index)"
                    />
                    <Button type="submit" variant="primary" class="vs-setting-list-ok">OK</Button>
                    <Button type="button" variant="secondary" @click="cancelFolderEdit(index)">
                      Cancel
                    </Button>
                  </form>
                  <div
                    v-else
                    class="vs-setting-list-row"
                    :class="{ selected: selectedFolderKey === key }"
                    role="listitem"
                    :data-folder-key="key"
                    :tabindex="
                      selectedFolderKey === key || (selectedFolderKey === null && index === 0)
                        ? 0
                        : -1
                    "
                    @focus="
                      setRowFocus('workspace.folders');
                      selectedFolderKey = key;
                    "
                    @click="selectedFolderKey = key"
                    @dblclick="startEditFolder(index)"
                    @contextmenu="openFolderMenu(key, $event)"
                    @keydown="openFolderMenu(key, $event); onFolderRowKeydown(index, folder, $event)"
                  >
                    <span class="vs-setting-list-value">{{ folder }}</span>
                    <span v-if="index === 0" class="vs-setting-list-sibling">primary</span>
                    <div class="vs-setting-list-actions">
                      <IconButton
                        icon="i-codicon-edit"
                        :label="`Edit folder ${folder}`"
                        @click.stop="startEditFolder(index)"
                      />
                      <IconButton
                        icon="i-codicon-close"
                        :label="`Remove folder ${folder}`"
                        @click.stop="removeFolder(folder, index)"
                      />
                    </div>
                  </div>
                </template>

                <form
                  v-if="addingFolder"
                  class="vs-setting-list-edit-row"
                  @submit.prevent="commitAddFolder"
                >
                  <input
                    ref="folderAddInput"
                    v-model="folderDraft"
                    type="text"
                    class="vs-input vs-setting-list-input"
                    :class="{ invalid: !!folderError }"
                    aria-label="Folder path"
                    placeholder="/path/to/folder or ../relative/path"
                    spellcheck="false"
                    autocomplete="off"
                    @focus="setRowFocus('workspace.folders')"
                    @keydown.esc.prevent.stop="cancelFolderEdit()"
                  />
                  <Button type="submit" variant="primary" class="vs-setting-list-ok">OK</Button>
                  <Button type="button" variant="secondary" @click="cancelFolderEdit()">
                    Cancel
                  </Button>
                </form>
              </div>
              <div v-if="folderError" class="vs-validation-message static" role="status">
                {{ folderError }}
              </div>
              <div v-if="!addingFolder" ref="addButtonWrap" class="vs-setting-list-new-row">
                <Button variant="secondary" class="vs-setting-list-add-btn" @click="browseFolder">
                  Browse...
                </Button>
                <Button variant="secondary" class="vs-setting-list-add-btn" @click="startAddFolder">
                  Add Folder
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div
          ref="instructionsRow"
          class="vs-setting-item vs-setting-item-multiline"
          :class="{
            focused: focusedKey === 'workspace.instructions',
            mouseover: hoveredKey === 'workspace.instructions',
          }"
          @mousedown="setRowFocus('workspace.instructions')"
          @focusin="setRowFocus('workspace.instructions')"
          @focusout="handleRowFocusOut('workspace.instructions', instructionsRow, $event)"
          @mouseenter="hoveredKey = 'workspace.instructions'"
          @mouseleave="hoveredKey === 'workspace.instructions' && (hoveredKey = '')"
        >
          <div class="vs-setting-title">
            <span class="vs-setting-category">Workspace: </span>
            <span class="vs-setting-label">Instructions</span>
          </div>
          <div class="vs-setting-description">
            Custom instructions injected into the system prompt for every conversation in this
            workspace (similar to <code>AGENTS.md</code>).
          </div>
          <div class="vs-setting-value">
            <div class="vs-setting-control vs-setting-control-multiline" @mousedown.stop>
              <textarea
                :value="workspace.instructions"
                class="vs-input vs-textarea"
                aria-label="Workspace instructions"
                rows="8"
                placeholder="Enter workspace instructions for the model…"
                @focus="setRowFocus('workspace.instructions')"
                @input="updateInstructions"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
    <ContextMenu ref="folderMenu" label="Workspace folder actions" :groups="folderMenuGroups"
      :on-error="(error) => { folderError = error instanceof Error ? error.message : String(error); }" />
  </section>
</template>
