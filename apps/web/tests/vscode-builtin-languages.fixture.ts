import * as monaco from "monaco-editor";
import { scopeKey } from "@harness/ui-di";
import type { Scope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { UiConfigService } from "@harness/ui-config";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { VscodeWindowCompatService, Uri } from "@harness/vscode-editor-compat";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";
import type { ExtensionContributions } from "@harness/vscode-editor-compat/contributions";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export function openWorkspace(root: string) {
  appScope().get(UiWorkspaceService).addRoot(root);
}

export async function prepareContributions(extensionsDir: string, root: string) {
  const scope = appScope();
  const rpc = scope.run(() => scope.get(RpcClientService).use(ExtHostRpcContract));
  await rpc.scanExtensions({ extensionsDir });
  await scope.get(ExtensionHostClientService).refreshContributions();
  scope.get(UiWorkspaceService).addRoot(root);
  const contributions = activeContributions.value as ExtensionContributions;
  return {
    issues: contributions.issues,
    grammars: Object.fromEntries(contributions.registeredGrammars),
  };
}

export async function refreshContributions() {
  await appScope().get(ExtensionHostClientService).refreshContributions();
}

export async function openDocument(path: string) {
  await appScope().get(VscodeWindowCompatService).showTextDocument(Uri.file(path));
}

function activeEditor() {
  const editors = monaco.editor.getEditors();
  const editor =
    editors.find((editor) => editor.hasTextFocus()) ??
    editors.find((editor) => editor.getDomNode()?.checkVisibility());
  if (!editor?.getModel()) throw new Error("No focused FileEditorView");
  return editor;
}

export function position(lineNumber: number, column: number) {
  activeEditor().setPosition({ lineNumber, column });
}

export function setTypeScriptTokenizationLineLimit(limit?: number) {
  appScope()
    .get(UiConfigService)
    .set(
      "[typescript]",
      limit === undefined ? undefined : { "editor.maxTokenizationLineLength": limit },
    );
}

export function editorState(lineNumber = 1, column = 1) {
  const editor = activeEditor();
  const model = editor.getModel()!;
  (model as any).tokenization.forceTokenization(model.getLineCount());
  return {
    language: model.getLanguageId(),
    embeddedLanguage: model.getLanguageIdAtPosition(lineNumber, column),
    text: model.getValue(),
    lineTokenCount: (model as any).tokenization.getLineTokens(lineNumber).getCount() as number,
    selectedText: model.getValueInRange(editor.getSelection()!),
    position: editor.getPosition(),
    scopes: monaco.editor
      .tokenize(model.getValue(), model.getLanguageId())
      .flat()
      .map((token) => token.type),
  };
}
