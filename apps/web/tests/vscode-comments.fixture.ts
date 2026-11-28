import { createCommentMenu } from "../../../packages/vscode-ext-host/src/menus.ts";
import { createRootScope } from "@harness/di";
import { UiStorageService } from "@harness/ui-storage";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createApp, effectScope, ref } from "vue";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { scopeKey } from "@harness/ui-di";
import { FileEditorService, type EditorDocument } from "@harness/ui-editor";
import {
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { createMainThreadComments } from "../../../packages/vscode-ext-host/src/main-thread/comments.ts";
import ExtensionCommentsPanel from "../../../packages/vscode-ext-host/src/components/ExtensionCommentsPanel.vue";

let adapter: ReturnType<typeof createMainThreadComments> | undefined;
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let cleanup: (() => void) | undefined;
let workerCount = 0;
export function openCommentsFixture(path: string) {
  const workers: Worker[] = [];
  workerCount = 0;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker() {
      const worker = new EditorWorker();
      workers.push(worker);
      workerCount++;
      return worker;
    },
  };
  const source: EditorDocument = {
    id: 1,
    path,
    root: path.slice(0, path.lastIndexOf("/")),
    relativePath: "sample.ts",
    name: "sample.ts",
    language: "plaintext",
    content: "first\nsecond\nthird",
    savedContent: "first\nsecond\nthird",
    mtimeMs: 1,
    size: 18,
    loading: false,
    binary: false,
    tooLarge: false,
    externalDeleted: false,
    externalChanged: false,
  };
  const editorContainer = document.createElement("div");
  editorContainer.style.cssText = "height:220px;width:650px";
  document.body.appendChild(editorContainer);
  const panel = document.createElement("div");
  panel.style.cssText = "width:650px;max-height:550px;overflow:auto";
  panel.hidden = true;
  document.body.appendChild(panel);
  editor = monaco.editor.create(editorContainer, { value: source.content, language: "plaintext" });
  const scope = effectScope();
  const tabScope = createRootScope();
  tabScope.provideAll([UiStorageService, UiTabsService]);
  const tabs = tabScope.get(UiTabsService);
  let compat: VscodeWindowCompatService;
  const commentMenu = createCommentMenu();
  const get = <T>(id: abstract new (...args: never[]) => T): T => {
    if (id === FileEditorService)
      return {
        getDocument: () => source,
        getDocumentById: () => source,
        openDocument: async () => source,
        closeDocument: () => {},
        isDirty: () => false,
        registerEditorHook: () => () => {},
      } as T;
    if (id === VscodeWorkspaceCompatService)
      return {
        getTextDocument: () => undefined,
        openTextDocument: () => compat.visibleTextEditors.value[0]!.document,
      } as T;
    if (id === UiTabsService) return tabs as T;
    if (id === UiWorkbenchService) return { theme: ref("dark") } as T;
    if (id === ExtensionHostClientService) return { comments: adapter, commentMenu } as T;
    throw new Error(`Unexpected comments fixture dependency: ${id.name}`);
  };
  compat = scope.run(() => runInInjectionContext({ get }, () => new VscodeWindowCompatService()))!;
  const unregister = compat.registerMonacoEditor(path, editor);
  adapter = scope.run(() =>
    createMainThreadComments(
      compat,
      (_session, command, args) =>
        (
          window as unknown as {
            invokeCommentCommand(command: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeCommentCommand(command, args),
      () => {
        panel.hidden = false;
      },
      new Map(),
    ),
  )!;
  const app = createApp(ExtensionCommentsPanel);
  app.provide(scopeKey, { get } as never);
  runInInjectionContext({ get }, () => app.mount(panel));
  cleanup = () => {
    adapter?.dispose();
    app.unmount();
    unregister();
    const model = editor?.getModel();
    editor?.dispose();
    model?.dispose();
    scope.stop();
    tabScope.dispose();
    for (const worker of workers) worker.terminate();
    panel.remove();
    editorContainer.remove();
    adapter = undefined;
    editor = undefined;
  };
}
export async function dispatchCommentsFixture(session: string, method: string, args: unknown[]) {
  if (!adapter) throw new Error("Comments fixture unavailable");
  if (!(await adapter.handle(session, method, args)))
    throw new Error(`Unexpected comment method: ${method}`);
}
export function inspectCommentsFixture() {
  return {
    workerCount,
    threads: adapter?.threads.size,
    controllers: adapter?.controllers.size,
    selection: editor?.getSelection(),
    decorations: editor
      ?.getModel()
      ?.getAllDecorations()
      .filter((value) => value.options.className?.startsWith("vscode-compat-dec-"))
      .map((value) => ({ range: value.range, hover: value.options.hoverMessage })),
  };
}
export function closeCommentsFixture() {
  cleanup?.();
  cleanup = undefined;
}
