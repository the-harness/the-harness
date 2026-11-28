<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IConfigurationService } from "monaco-editor/esm/vs/platform/configuration/common/configuration.js";
import { useService } from "@harness/ui-di";
import { UiConfigService } from "@harness/ui-config";
import { EditorOptionsField, FileEditorService } from "@harness/ui-editor";
import { UiNotificationService } from "@harness/ui-notifications";
import { TabContext, UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { ensureMonacoWorkers } from "../monaco-environment.ts";
import { bindFileEditorTab, type FileEditorTabDescriptor } from "../tabs/FileEditorTab.ts";

ensureMonacoWorkers();

const tabContext = useService(TabContext) as TabContext<FileEditorTabDescriptor>;
const editorService = useService(FileEditorService);
const tabs = useService(UiTabsService);
const config = useService(UiConfigService);
const workbench = useService(UiWorkbenchService);
const notifications = useService(UiNotificationService);

const containerRef = ref<HTMLElement | null>(null);
const showLoadingProgress = ref(false);
let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
let modelInstance: monaco.editor.ITextModel | null = null;
let modelContent = "";
let unregisterCompat: (() => void) | null = null;
let layoutObserver: ResizeObserver | undefined;
let modelHasBaseline = false;
let suppressModelChange = false;

const doc = computed(() => editorService.getDocumentById(tabContext.descriptor.documentId));
const isDirty = computed(() => doc.value !== undefined && editorService.isDirty(doc.value));
const isPreview = computed(() => editorService.previewPath.value === doc.value?.path);
const showEditor = computed(() => {
  const source = doc.value;
  return Boolean(source && !source.error && !source.tooLarge && !source.binary);
});
const wordBasedSuggestions = computed(
  () =>
    (config.get(EditorOptionsField)?.wordBasedSuggestions as
      | monaco.editor.IGlobalEditorOptions["wordBasedSuggestions"]
      | undefined) ?? "matchingDocuments",
);
const editorOptions = computed<monaco.editor.IStandaloneEditorConstructionOptions>(() => {
  const editorConfig = config.get(EditorOptionsField);
  const get = <T>(name: string, fallback: T): T =>
    (editorConfig?.[name] as T | undefined) ?? fallback;
  const colorDecorators = get<string | boolean>("defaultColorDecorators", true);
  return {
    readOnly: doc.value?.loading ?? false,
    tabSize: get("tabSize", 2),
    insertSpaces: get("insertSpaces", true),
    autoIndent: get<monaco.editor.IEditorOptions["autoIndent"]>("autoIndent", "full"),
    wordWrap: get<monaco.editor.IEditorOptions["wordWrap"]>("wordWrap", "off"),
    defaultColorDecorators: colorDecorators !== "never" && colorDecorators !== false,
    quickSuggestions: get<monaco.editor.IEditorOptions["quickSuggestions"]>("quickSuggestions", {
      other: "on",
      comments: "off",
      strings: "off",
    }),
    unicodeHighlight: {
      ambiguousCharacters: get("unicodeHighlight.ambiguousCharacters", true),
      invisibleCharacters: get("unicodeHighlight.invisibleCharacters", true),
    },
  };
});

function applyEditorOptions() {
  if (!modelInstance || !editorInstance) return;
  editorInstance.updateOptions(editorOptions.value);
  // Monaco's word completion provider reads shared configuration instead of editor options.
  const configuration = StandaloneServices.get(IConfigurationService) as {
    getValue(key: string): Record<string, unknown>;
    updateValue(key: string, value: Record<string, unknown>): Promise<void>;
  };
  const languageKey = `[${modelInstance.getLanguageId()}]`;
  void configuration.updateValue(languageKey, {
    ...configuration.getValue(languageKey),
    "editor.wordBasedSuggestions": wordBasedSuggestions.value,
  });
  modelInstance.updateOptions({
    tabSize: editorOptions.value.tabSize,
    indentSize: "tabSize",
    insertSpaces: editorOptions.value.insertSpaces,
  });
}

function monacoTheme(theme: "dark" | "light"): string {
  return workbench.themeName.value ?? (theme === "dark" ? "vs-dark" : "vs");
}

function layoutEditor() {
  const container = containerRef.value;
  if (!container?.isConnected) return;
  const { clientWidth: width, clientHeight: height } = container;
  // Detached Dockview panels must retain their last visible size.
  if (width > 0 && height > 0) editorInstance?.layout({ width, height });
}

async function handleSave() {
  if (!doc.value) return;
  try {
    await editorService.saveDocument(doc.value.path);
  } catch (error) {
    notifications.notify(error instanceof Error ? error.message : "Failed to save file");
  }
}

function handleReload() {
  if (doc.value) void editorService.reloadDocument(doc.value.path);
}

onMounted(() => {
  const source = doc.value;
  if (!containerRef.value || !source) return;
  bindFileEditorTab(tabs, editorService, tabContext.tab, source);

  monaco.editor.setTheme(monacoTheme(workbench.theme.value));
  modelHasBaseline = !source.loading && source.error === undefined;
  modelInstance = monaco.editor.createModel(source.content, source.language);
  modelContent = modelInstance.getValue();
  editorInstance = monaco.editor.create(containerRef.value, {
    model: modelInstance,
    minimap: { enabled: true },
    fontSize: 13,
    scrollBeyondLastLine: false,
    ...editorOptions.value,
  });
  applyEditorOptions();
  layoutObserver = new ResizeObserver(layoutEditor);
  layoutObserver.observe(containerRef.value);
  layoutEditor();

  editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void handleSave();
  });

  modelInstance.onDidChangeContent((event) => {
    if (suppressModelChange || !modelInstance || doc.value !== source) return;
    const isCurrentEdit =
      modelContent === source.content && event.versionId === modelInstance.getVersionId();
    modelContent = modelInstance.getValue();
    editorService.updateContent(source.path, modelContent, isCurrentEdit ? event : undefined);
  });

  unregisterCompat = editorService.notifyEditorMounted(source.path, editorInstance, tabContext.tab.tabId);
});

watch(
  () => workbench.theme.value,
  (theme) => {
    monaco.editor.setTheme(monacoTheme(theme));
  },
);

watch(
  () => doc.value?.loading,
  (loading, _, onCleanup) => {
    showLoadingProgress.value = false;
    if (!loading) return;
    const timer = setTimeout(() => {
      showLoadingProgress.value = true;
    }, 200);
    onCleanup(() => clearTimeout(timer));
  },
  { immediate: true },
);

watch(
  [() => doc.value?.content, () => doc.value?.loading, () => doc.value?.error],
  ([nextContent, loading, error]) => {
    if (!modelInstance || nextContent === undefined) return;
    const initialLoad = !modelHasBaseline;
    if (initialLoad && (loading || error !== undefined)) return;
    modelHasBaseline = true;
    if (modelContent === nextContent) return;
    suppressModelChange = true;
    try {
      if (initialLoad) {
        modelInstance.setValue(nextContent);
        return;
      }
      const eol = nextContent.match(/\r\n|\n/)?.[0];
      if (eol)
        modelInstance.setEOL(
          eol === "\r\n"
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF,
        );
      modelInstance.pushEditOperations(
        [],
        [{ range: modelInstance.getFullModelRange(), text: nextContent }],
        () => null,
      );
    } finally {
      suppressModelChange = false;
      modelContent = modelInstance.getValue();
    }
  },
);

watch(
  () => doc.value?.language,
  (lang) => {
    if (!modelInstance || !lang) return;
    monaco.editor.setModelLanguage(modelInstance, lang);
    applyEditorOptions();
  },
);

watch(
  [() => tabs.groups.value.some((group) => group.activeTabId === tabContext.tab.tabId), showEditor],
  ([active, visible]) => {
    if (active && visible) layoutEditor();
  },
  { flush: "post" },
);

watch([editorOptions, wordBasedSuggestions], applyEditorOptions, { deep: true });

onBeforeUnmount(() => {
  layoutObserver?.disconnect();
  unregisterCompat?.();
  unregisterCompat = null;
  editorInstance?.dispose();
  modelInstance?.dispose();
  editorInstance = null;
  modelInstance = null;
});
</script>

<template>
  <div class="file-editor-view" :class="{ 'is-preview': isPreview }">
    <div
      v-if="showLoadingProgress"
      class="file-editor-progress"
      role="progressbar"
      aria-label="Loading file"
    />
    <div v-if="doc?.externalDeleted || doc?.externalChanged" class="file-editor-banner">
      <span v-if="doc.externalDeleted">File was deleted on disk.</span>
      <span v-else>File changed on disk while you have unsaved edits.</span>
      <div class="file-editor-banner-actions">
        <button v-if="!doc.externalDeleted" type="button" @click="handleReload">Reload</button>
        <button type="button" @click="handleSave">Save</button>
      </div>
    </div>

    <div v-if="doc?.error" class="file-editor-placeholder is-error">{{ doc.error }}</div>
    <div v-else-if="doc?.tooLarge" class="file-editor-placeholder">
      File is too large to edit in browser ({{ (doc.size / 1024 / 1024).toFixed(2) }} MB).
    </div>
    <div v-else-if="doc?.binary" class="file-editor-placeholder">
      Binary file cannot be displayed in the text editor.
    </div>

    <div v-show="showEditor" ref="containerRef" class="file-editor-monaco" />

    <div v-if="isDirty" class="file-editor-statusbar">
      <span>Unsaved changes</span>
      <button type="button" @click="handleSave">Save (Cmd+S)</button>
    </div>
  </div>
</template>

<style scoped>
.file-editor-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  position: relative;
}

.file-editor-progress {
  position: absolute;
  inset: 0 0 auto;
  z-index: 1;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}

.file-editor-progress::before {
  content: "";
  display: block;
  width: 25%;
  height: 100%;
  background: var(--accent);
  animation: file-editor-progress 1.2s ease-in-out infinite;
}

@keyframes file-editor-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(400%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .file-editor-progress::before {
    width: 100%;
    animation: none;
  }
}

.file-editor-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--warning-bg);
  color: var(--fg);
  border-bottom: 1px solid var(--border);
}

.file-editor-banner-actions {
  display: flex;
  gap: 8px;
}

.file-editor-monaco {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.file-editor-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted);
  padding: 24px;
}

.file-editor-placeholder.is-error {
  color: var(--red);
}

.file-editor-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  border-top: 1px solid var(--border);
  background: var(--raised);
}
</style>
