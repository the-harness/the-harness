import * as monaco from "monaco-editor";
import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { RpcClientService } from "@harness/rpc";
import { UiConfigService } from "@harness/ui-config";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { FileEditorService } from "@harness/ui-editor";
import { Uri, VscodeWindowCompatService } from "@harness/vscode-editor-compat";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function load(directory: string, root: string) {
  const scope = appScope();
  await scope.run(() =>
    scope
      .get(RpcClientService)
      .use(ExtHostRpcContract)
      .scanExtensions({ extensionsDir: directory }),
  );
  scope.get(UiWorkspaceService).addRoot(root);
  await scope.get(ExtensionHostClientService).refreshContributions();
}

export async function open(path: string) {
  await appScope().get(VscodeWindowCompatService).showTextDocument(Uri.file(path));
}

export function snapshot(path: string) {
  const active = appScope().get(VscodeWindowCompatService).activeTextEditor.value;
  const editor =
    active?.document.fileName === path
      ? monaco.editor.getEditors().find((editor) => editor.hasTextFocus())
      : undefined;
  const model = editor?.getModel();
  const document = appScope().get(FileEditorService).getDocument(path);
  return {
    language: model?.getLanguageId(),
    text: model?.getValue(),
    insertSpaces: model?.getOptions().insertSpaces,
    tabSize: model?.getOptions().tabSize,
    wordWrap: editor?.getOption(monaco.editor.EditorOption.wordWrap),
    wrapping: editor?.getOption(monaco.editor.EditorOption.wrappingInfo),
    savedContent: document?.savedContent,
    dirty: document?.content !== document?.savedContent,
  };
}

export function overrideGo() {
  appScope().get(UiConfigService).set("[go]", { "editor.insertSpaces": true, "editor.tabSize": 4 });
}

export function overrideEol() {
  appScope().get(UiConfigService).set("[shellscript]", { "files.eol": "\r\n" });
}
