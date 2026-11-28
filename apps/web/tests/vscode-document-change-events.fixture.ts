import * as monaco from "monaco-editor";
import { createApp, effectScope, h, nextTick, ref } from "vue";
import { createRootScope } from "@harness/di";
import { UiConfigService } from "@harness/ui-config";
import { provideScope } from "@harness/ui-di";
import { FileEditorService, FileEditorTabDescriptor, FileEditorView } from "@harness/ui-editor";
import { UiNotificationService } from "@harness/ui-notifications";
import { TabContext, UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { VscodeWorkspaceCompatService } from "@harness/vscode-editor-compat";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { serializeDocumentChange } from "../../../packages/vscode-ext-host/src/main-thread/workspace.ts";

const initialText = "<div\r\n  class\r\n";
let fixture: Awaited<ReturnType<typeof mountEditor>>;

async function mountEditor(root: string) {
  const relativePath = "index.html";
  const scope = effectScope();
  let saved = initialText;
  const services = new Map<unknown, unknown>([
    [
      UiWorkspaceService,
      {
        activeRoots: ref([root]),
        onFileChange: () => () => {},
        getRoot: () => ({
          async readFile() {
            return {
              content: saved,
              size: saved.length,
              mtimeMs: 1,
              binary: false,
              tooLarge: false,
            };
          },
        }),
      },
    ],
    [UiConfigService, { get: (_key: string, fallback: unknown) => fallback }],
    [UiWorkbenchService, { theme: ref("dark"), themeName: ref() }],
    [UiTabsService, { tabs: new Map(), groups: ref([]) }],
    [
      UiNotificationService,
      {
        notify(message: string) {
          throw new Error(message);
        },
      },
    ],
  ]);
  const injector = {
    get<T>(id: abstract new (...args: never[]) => T): T {
      if (!services.has(id)) throw new Error(`Missing editor fixture service ${id.name}`);
      return services.get(id) as T;
    },
  };
  const files = scope.run(() => runInInjectionContext(injector, () => new FileEditorService()))!;
  services.set(FileEditorService, files);
  const source = await files.openDocument(root, relativePath);
  const tabScope = createRootScope();
  const descriptor = new FileEditorTabDescriptor({ documentId: source.id, name: source.name });
  const tab = new TabContext({
    tabId: "document-change",
    descriptor,
    scope: tabScope,
    title: source.name,
    dirty: false,
    pinned: false,
  });
  services.set(TabContext, tab);
  const container = document.createElement("div");
  container.style.cssText = "height:240px;width:600px";
  document.body.appendChild(container);
  const app = createApp({
    setup() {
      provideScope(injector as unknown as ReturnType<typeof createRootScope>);
      return () => h(FileEditorView);
    },
  });
  app.mount(container);
  const workspace = scope.run(() =>
    runInInjectionContext(injector, () => new VscodeWorkspaceCompatService()),
  )!;
  const editor = monaco.editor
    .getEditors()
    .find((editor) => container.contains(editor.getContainerDomNode()))!;
  editor.updateOptions({ occurrencesHighlight: "off" });
  editor.focus();
  editor.setPosition({ lineNumber: 2, column: 8 });
  return {
    document: workspace.getTextDocument(source.path)!,
    workspace,
    editor,
    async reload(text: string) {
      saved = text;
      await files.reloadDocument(source.path);
      await nextTick();
    },
    close() {
      app.unmount();
      tabScope.dispose();
      container.remove();
      scope.stop();
    },
  };
}

export async function openDocumentChangeFixture(
  root: string,
  emit: (payload: unknown) => Promise<unknown>,
) {
  fixture = await mountEditor(root);
  fixture.workspace.onDidChangeTextDocument((event) => void emit(serializeDocumentChange(event)));
  return fixture.document.toJSON();
}

export async function applyDocumentChangeEdits() {
  const { editor } = fixture;
  editor.pushUndoStop();
  editor.executeEdits("fixture", [
    { range: new monaco.Range(1, 2, 1, 5), text: "main" },
    { range: new monaco.Range(2, 3, 2, 3), text: "\t" },
  ]);
  editor.pushUndoStop();
  editor.trigger("fixture", "undo", null);
  editor.trigger("fixture", "redo", null);
  await nextTick();
}

export async function reloadDocumentChangeFixture(text: string) {
  await fixture.reload(text);
}

export function closeDocumentChangeFixture() {
  fixture.close();
}
