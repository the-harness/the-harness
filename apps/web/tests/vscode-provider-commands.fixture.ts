import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { effectScope, shallowRef } from "vue";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import {
  VscodeLanguagesCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import { associateFileModel } from "../../../packages/vscode-editor-compat/src/model-uri.ts";
import { createMainThreadLanguages } from "../../../packages/vscode-ext-host/src/main-thread/languages.ts";
import {
  TextDocumentData,
  Uri,
  type TextDocumentSnapshot,
} from "../../../packages/vscode-types/src/index.ts";

let handle: ((id: string, method: string, args: unknown[]) => Promise<unknown>) | undefined;
let close: (() => void) | undefined;

export function openProviderCommandModel(
  snapshot: TextDocumentSnapshot,
  execute: Parameters<typeof createMainThreadLanguages>[1],
  unloaded: readonly TextDocumentSnapshot[] = [],
) {
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment ??= {
    getWorker(_id, label) {
      return label === "javascript" || label === "typescript"
        ? new TypeScriptWorker()
        : new EditorWorker();
    },
  };
  const scope = effectScope();
  const document = new TextDocumentData(snapshot);
  const textDocuments = shallowRef([document]);
  const languages = scope.run(() =>
    runInInjectionContext(
      {
        get<T>(id: abstract new (...args: never[]) => T): T {
          if (id === VscodeWorkspaceCompatService) return { textDocuments } as T;
          throw new Error(`Unexpected provider command fixture service: ${id.name}`);
        },
      },
      () => new VscodeLanguagesCompatService(),
    ),
  )!;
  const model = monaco.editor.createModel(document.getText(), document.languageId);
  const forgetModel =
    document.uri.scheme === "file" ? associateFileModel(model, () => document.uri) : undefined;
  const bridge = createMainThreadLanguages(languages, execute);
  const client = Object.assign(Object.create(WorkspaceExtensionHostClient.prototype), {
    foregroundState: shallowRef(true),
    handleLanguages: bridge,
    handleWorkspace(method: string, args: unknown[]) {
      if (method !== "workspace.openTextDocument")
        throw new Error(`Unexpected workspace call: ${method}`);
      const uri = Uri.from(args[0] as TextDocumentSnapshot["uri"]).toString();
      const opened = unloaded.find((entry) => Uri.from(entry.uri).toString() === uri);
      if (!opened) throw new Error(`Missing fixture working copy: ${uri}`);
      textDocuments.value = [...textDocuments.value, new TextDocumentData(opened)];
      return opened;
    },
  }) as { handleMainCall(id: string, method: string, args: unknown[]): Promise<unknown> };
  handle = (id, method, args) => client.handleMainCall(id, method, args);
  close = () => {
    bridge.dispose();
    forgetModel?.();
    model.dispose();
    scope.stop();
  };
  return model.uri.toJSON();
}

export function dispatchProviderCommand(id: string, method: string, args: unknown[]) {
  if (!handle) throw new Error("Provider command model is unavailable");
  return handle(id, method, args);
}

export function hasResourceQueryModel(uri: TextDocumentSnapshot["uri"]) {
  return !!monaco.editor.getModel(monaco.Uri.from(uri));
}

export function closeProviderCommandModel() {
  close?.();
  close = undefined;
  handle = undefined;
}
