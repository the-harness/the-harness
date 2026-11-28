import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IConfigurationService } from "monaco-editor/esm/vs/platform/configuration/common/configuration.js";
import { ILanguageFeaturesService } from "monaco-editor/esm/vs/editor/common/services/languageFeatures.js";
import { createApp, effectScope, h, nextTick, reactive, ref } from "vue";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { UiConfigService } from "@harness/ui-config";
import { UiStorageService } from "@harness/ui-storage";
import { FileEditorService, FileEditorTabDescriptor, FileEditorView } from "@harness/ui-editor";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiNotificationService } from "@harness/ui-notifications";
import { TabContext, UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { VscodeWindowCompatService } from "@harness/vscode-editor-compat";
import { ClientContributions } from "../../../packages/vscode-ext-host/src/client-contributions.ts";
import type { ExtensionContributionSnapshot } from "@harness/vscode-editor-compat/contributions";

let cleanup: (() => void) | undefined;
let config: UiConfigService;
let files: FileEditorService;
let current: monaco.editor.IStandaloneCodeEditor | undefined;
let changeSnapshots: ((snapshots: ExtensionContributionSnapshot[]) => Promise<void>) | undefined;
let activePath: string | undefined;
let failSave = false;
const saved = new Map<string, string>();
let unmount: (() => void) | undefined;

export async function startContentConfiguration(snapshots: ExtensionContributionSnapshot[]) {
  cleanup?.();
  const scope = effectScope();
  const services = new Map<unknown, unknown>();
  const resolver = {
    get<T>(id: abstract new (...args: any[]) => T): T {
      if (!services.has(id))
        throw new Error(`Missing content configuration dependency: ${id.name}`);
      return services.get(id) as T;
    },
  };
  services.set(UiStorageService, { scope: () => ({ use: () => reactive({ values: {} }) }) });
  services.set(UiWorkspaceService, {
    onFileChange: () => () => {},
    getRoot: () => ({
      async readFile(path: string) {
        const content = saved.get(path) ?? "";
        return { content, size: content.length, mtimeMs: 1, binary: false, tooLarge: false };
      },
      async writeFile(path: string, content: string) {
        if (failSave) throw new Error("Read-only fixture");
        saved.set(path, content);
        return { mtimeMs: 2, size: content.length };
      },
    }),
  });
  services.set(UiWorkbenchService, { theme: ref("dark") });
  services.set(UiTabsService, { tabs: new Map(), groups: ref([]) });
  services.set(UiNotificationService, {
    notify(message: string) {
      throw new Error(message);
    },
  });
  services.set(VscodeWindowCompatService, {
    registerMonacoEditor(_path: string, editor: monaco.editor.IStandaloneCodeEditor) {
      current = editor;
      return () => {
        current = undefined;
      };
    },
  });
  scope.run(() =>
    runInInjectionContext(resolver, () => {
      config = new UiConfigService();
      services.set(UiConfigService, config);
      config.useDefaults({ "editor.tabSize": 3 });
      files = new FileEditorService();
      services.set(FileEditorService, files);
    }),
  );
  const contributions = scope.run(
    () =>
      new ClientContributions(
        config,
        resolver.get(UiWorkbenchService),
        resolver.get(UiNotificationService),
        async () => snapshots,
      ),
  )!;
  changeSnapshots = async (next) => {
    snapshots = next;
    await contributions.refresh();
    await nextTick();
  };
  await changeSnapshots(snapshots);
  cleanup = () => {
    unmount?.();
    unmount = undefined;
    contributions.dispose();
    scope.stop();
    saved.clear();
    changeSnapshots = undefined;
    activePath = undefined;
    failSave = false;
  };
  return resolver;
}

let resolver: Awaited<ReturnType<typeof startContentConfiguration>>;
export async function loadContentConfiguration(snapshots: ExtensionContributionSnapshot[]) {
  resolver = await startContentConfiguration(snapshots);
}

export async function openContentFile(path: string, content = "") {
  if (unmount) await new Promise((resolve) => setTimeout(resolve, 60));
  unmount?.();
  saved.set(path, content);
  const doc = await files.openDocument("/fixture", path);
  activePath = doc.path;
  const tabScope = createRootScope();
  const descriptor = new FileEditorTabDescriptor({ documentId: doc.id, name: doc.name });
  const tabContext = new TabContext({
    tabId: "content-configuration",
    descriptor,
    scope: tabScope,
    title: descriptor.defaultTitle,
    dirty: false,
    pinned: false,
  });
  const container = document.createElement("div");
  container.style.cssText = "height:240px;width:600px";
  document.body.appendChild(container);
  const app = createApp({
    setup() {
      provideScope({
        get(id: unknown) {
          if (id === TabContext) return tabContext;
          return resolver.get(id as never);
        },
      } as never);
      return () => h(FileEditorView);
    },
  });
  app.mount(container);
  unmount = () => {
    app.unmount();
    tabScope.dispose();
    container.remove();
  };
  await nextTick();
  return observeContentFile();
}

export function observeContentFile() {
  if (!current) throw new Error("Content editor is not mounted");
  const model = current.getModel()!;
  const options = current.getRawOptions();
  return {
    language: model.getLanguageId(),
    model: model.getOptions(),
    text: model.getValue(),
    eol: model.getEOL(),
    options: {
      wordWrap: options.wordWrap,
      autoIndent: options.autoIndent,
      quickSuggestions: current.getOption(monaco.editor.EditorOption.quickSuggestions),
      unicodeHighlight: current.getOption(monaco.editor.EditorOption.unicodeHighlighting),
      defaultColorDecorators: current.getOption(monaco.editor.EditorOption.defaultColorDecorators),
      wordBasedSuggestions: StandaloneServices.get(IConfigurationService).getValue(
        "editor.wordBasedSuggestions",
        { overrideIdentifier: model.getLanguageId() },
      ),
    },
    wrapping: current.getOption(monaco.editor.EditorOption.wrappingInfo),
    dirty: activePath ? files.isDirty(activePath) : undefined,
  };
}

export async function insertContentTab() {
  current!.setPosition({ lineNumber: 1, column: 1 });
  current!.trigger("keyboard", "tab", null);
  await nextTick();
  return observeContentFile();
}
export async function contentWordSuggestions(createOtherEditor = false) {
  const model = current!.getModel()!;
  const previous = model.getValue();
  model.setValue("uniqueContentWord\nuni");
  const container = document.createElement("div");
  const other = createOtherEditor
    ? monaco.editor.create(container, {
        value: "other",
        language: "go",
        wordBasedSuggestions: "matchingDocuments",
      })
    : undefined;
  const provider = StandaloneServices.get(ILanguageFeaturesService)
    .completionProvider.all(model)
    .find((provider) => provider._debugDisplayName === "wordbasedCompletions");
  if (!provider) throw new Error("Monaco word-based completion provider is missing");
  try {
    const result = await provider.provideCompletionItems(
      model,
      { lineNumber: 2, column: 4 },
      { triggerKind: 0 },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    );
    const labels =
      result?.suggestions.map((item) =>
        typeof item.label === "string" ? item.label : item.label.label,
      ) ?? [];
    result?.dispose?.();
    return labels;
  } finally {
    other?.dispose();
    model.setValue(previous);
    await nextTick();
  }
}
export async function setContentConfiguration(key: string, value: unknown) {
  config.set(key, value);
  await nextTick();
  return observeContentFile();
}
export async function switchContentLanguage(path: string, language: string) {
  files.getDocument(`/fixture/${path}`)!.language = language;
  await nextTick();
  return observeContentFile();
}
export async function saveContentFile(path: string) {
  await files.saveDocument(`/fixture/${path}`);
  await nextTick();
  return {
    ...observeContentFile(),
    saved: saved.get(path),
    document: files.getDocument(`/fixture/${path}`),
  };
}
export async function failContentSave(path: string) {
  failSave = true;
  let error: string | undefined;
  try {
    await files.saveDocument(`/fixture/${path}`);
  } catch (reason) {
    error = String(reason);
  } finally {
    failSave = false;
  }
  return { ...observeContentFile(), saved: saved.get(path), error };
}
export async function replaceContentContributions(snapshots: ExtensionContributionSnapshot[]) {
  await changeSnapshots!(snapshots);
  return observeContentFile();
}
export async function closeContentConfiguration() {
  await new Promise((resolve) => setTimeout(resolve, 60));
  cleanup?.();
  cleanup = undefined;
}
