import * as monaco from "monaco-editor";
import { scopeKey } from "@harness/ui-di";
import type { Scope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { VscodeWindowCompatService, Uri } from "@harness/vscode-editor-compat";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";
import type { ExtensionContributions } from "@harness/vscode-editor-compat/contributions";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function serverContributions() {
  const scope = appScope();
  return scope.run(() => scope.get(RpcClientService).use(ExtHostRpcContract).getContributions({}));
}

export function contributionState() {
  const contributions = activeContributions.value as ExtensionContributions | undefined;
  return {
    grammar: contributions?.registeredGrammars.get("powershell"),
    theme: contributions?.themeName,
    snippets:
      contributions?.snippets.filter((snippet) => snippet.extensionId === "vscode.powershell")
        .length ?? 0,
  };
}

export async function openDocument(root: string, name: string) {
  const scope = appScope();
  scope.get(UiWorkspaceService).addRoot(root);
  await scope.get(VscodeWindowCompatService).showTextDocument(Uri.file(`${root}/${name}`));
}

export function editorState(path: string) {
  const active = appScope().get(VscodeWindowCompatService).activeTextEditor.value;
  const model =
    active?.document.fileName === path
      ? monaco.editor
          .getEditors()
          .find((editor) => editor.hasTextFocus())
          ?.getModel()
      : undefined;
  return {
    language: model?.getLanguageId(),
    tokens: model
      ? monaco.editor
          .tokenize(model.getValue(), model.getLanguageId())
          .flat()
          .map((token) => token.type)
      : [],
    text: model?.getValue(),
  };
}
