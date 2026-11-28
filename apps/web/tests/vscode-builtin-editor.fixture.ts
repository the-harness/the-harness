import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { effectScope, reactive, shallowRef } from "vue";
import { SnippetController2 } from "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import {
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { FileEditorService, type EditorDocument } from "@harness/ui-editor";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiTabsService } from "@harness/ui-workbench";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { createMainThreadLanguages } from "../../../packages/vscode-ext-host/src/main-thread/languages.ts";
import { createMainThreadEditor } from "../../../packages/vscode-ext-host/src/main-thread/editor.ts";
import { createMainThreadWorkspace } from "../../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { Selection, type TextDocumentSnapshot } from "../../../packages/vscode-types/src/index.ts";

let cleanup: (() => void) | undefined;
let addDocument: ((snapshot: TextDocumentSnapshot, caretOffset: number) => void) | undefined;
let dispatch: ((session: string, method: string, args: unknown[]) => Promise<unknown>) | undefined;
let observe: (() => unknown) | undefined;

export function openBuiltinEditor(snapshot: TextDocumentSnapshot, caretOffset: number) {
  cleanup?.();
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment ??= {
    getWorker(_id, label) {
      if (label === "json") return new JsonWorker();
      if (["css", "scss", "less"].includes(label)) return new CssWorker();
      if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
      if (["typescript", "javascript"].includes(label)) return new TsWorker();
      return new EditorWorker();
    },
  };
  const root = snapshot.uri.path!.slice(0, snapshot.uri.path!.lastIndexOf("/"));
  const sources = reactive(new Map<string, EditorDocument>());
  const models = new Map<
    string,
    { editor: monaco.editor.IStandaloneCodeEditor; cleanup(): void }
  >();
  const fileEditor = {
    documents: sources,
    previewPath: shallowRef<string | undefined>(),
    onDidEditContent: () => () => {},
    registerEditorHook: () => () => {},
    getDocument: (path: string) => sources.get(path),
    isDirty: (path: string) => sources.get(path)?.content !== sources.get(path)?.savedContent,
    async openDocument(folder: string, relative: string) {
      const source = sources.get(`${folder}/${relative}`);
      if (!source) throw new Error(`Fixture document is not loaded: ${folder}/${relative}`);
      return source;
    },
  };
  const workspace = { activeRoots: shallowRef([root]) };
  const scope = effectScope();
  let workspaceCompat: VscodeWorkspaceCompatService;
  const context = {
    get<T>(id: abstract new (...args: never[]) => T): T {
      if (id === FileEditorService) return fileEditor as T;
      if (id === UiWorkspaceService) return workspace as T;
      if (id === UiTabsService) return { groups: shallowRef([]), useRenderer() {} } as T;
      if (id === VscodeWorkspaceCompatService) return workspaceCompat as T;
      throw new Error(`Unexpected editor fixture dependency: ${id.name}`);
    },
  };
  workspaceCompat = scope.run(() =>
    runInInjectionContext(context, () => new VscodeWorkspaceCompatService()),
  )!;
  const windowCompat = scope.run(() =>
    runInInjectionContext(context, () => new VscodeWindowCompatService()),
  )!;
  const languages = runInInjectionContext(context, () => new VscodeLanguagesCompatService());
  addDocument = (value, offset) => {
    const path = value.uri.path!;
    if (models.has(path)) throw new Error(`Fixture document already loaded: ${path}`);
    const source = reactive<EditorDocument>({
      id: sources.size + 1,
      path,
      root,
      relativePath: path.slice(root.length + 1),
      name: path.split("/").at(-1)!,
      language: value.languageId,
      content: value.text,
      savedContent: value.text,
      mtimeMs: 1,
      size: value.text.length,
      loading: false,
      binary: false,
      tooLarge: false,
      externalChanged: false,
      externalDeleted: false,
    });
    sources.set(path, source);
    const container = window.document.createElement("div");
    container.style.cssText = "height:220px;width:800px";
    window.document.body.appendChild(container);
    const model = monaco.editor.createModel(
      value.text,
      value.languageId,
      monaco.Uri.from(value.uri),
    );
    model.updateOptions({ tabSize: 2, insertSpaces: true });
    const editor = monaco.editor.create(container, { model, automaticLayout: true });
    const unregister = windowCompat.registerMonacoEditor(path, editor);
    const document = workspaceCompat.getTextDocument(path)!;
    const caret = document.positionAt(offset);
    windowCompat.activeTextEditor.value!.selection = new Selection(caret, caret);
    const update = model.onDidChangeContent(() => {
      source.content = model.getValue();
      document.refresh();
    });
    models.set(path, {
      editor,
      cleanup() {
        update.dispose();
        unregister();
        editor.dispose();
        model.dispose();
        container.remove();
      },
    });
  };
  addDocument(snapshot, caretOffset);
  const editor = createMainThreadEditor(windowCompat, workspaceCompat);
  const client = Object.assign(Object.create(WorkspaceExtensionHostClient.prototype), {
    foregroundState: shallowRef(true),
    windowCompat,
    workspaceCompat,
    editor,
    fileDecorations: { handle: () => false },
    handleLanguages: createMainThreadLanguages(languages, async () => {
      throw new Error("Unexpected provider invocation in editor fixture");
    }),
    handleWorkspace: createMainThreadWorkspace(
      workspace as UiWorkspaceService,
      undefined as never,
      workspaceCompat,
    ),
  }) as { handleMainCall(session: string, method: string, args: unknown[]): Promise<unknown> };
  dispatch = (session, method, args) => client.handleMainCall(session, method, args);
  observe = () => {
    const active = windowCompat.activeTextEditor.value!;
    return {
      text: active.document.getText(),
      selections: active.selections,
      inSnippet: SnippetController2.get(
        models.get(active.document.fileName)!.editor,
      )?.isInSnippet(),
      document: active.document.toJSON(),
    };
  };
  cleanup = () => {
    editor.dispose();
    for (const value of models.values()) value.cleanup();
    scope.stop();
    dispatch = undefined;
    observe = undefined;
    addDocument = undefined;
  };
}
export function addBuiltinEditorDocument(snapshot: TextDocumentSnapshot, offset = 0) {
  if (!addDocument) throw new Error("Editor fixture is not open");
  addDocument(snapshot, offset);
}
export async function dispatchBuiltinEditor(session: string, method: string, args: unknown[]) {
  if (!dispatch) throw new Error("Editor fixture is not open");
  return dispatch(session, method, args);
}
export function observeBuiltinEditor() {
  if (!observe) throw new Error("Editor fixture is not open");
  return observe();
}
export async function closeBuiltinEditor() {
  // Monaco 0.52 schedules uncaught highlight promises 50 ms after the last cursor change.
  await new Promise((resolve) => setTimeout(resolve, 60));
  cleanup?.();
  cleanup = undefined;
}
