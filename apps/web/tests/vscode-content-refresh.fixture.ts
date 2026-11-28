import * as monaco from "monaco-editor";
import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { RpcClientService } from "@harness/rpc";
import { UiConfigService } from "@harness/ui-config";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { Uri, VscodeWindowCompatService } from "@harness/vscode-editor-compat";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";
import type { ExtensionContributions } from "@harness/vscode-editor-compat/contributions";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import type { ClientContributions } from "../../../packages/vscode-ext-host/src/client-contributions.ts";
import type { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function openDocument(root: string, name: string) {
  const scope = appScope();
  scope.get(UiConfigService).set("workbench.colorTheme", "Monokai");
  scope.get(UiWorkspaceService).addRoot(root);
  await scope.get(VscodeWindowCompatService).showTextDocument(Uri.file(`${root}/${name}`));
  monaco.languages.registerCompletionItemProvider("groovy", {
    provideCompletionItems: (_model, position) => ({
      suggestions: [
        {
          label: "foreign-provider",
          kind: monaco.languages.CompletionItemKind.Text,
          insertText: "foreign-provider",
          range: new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
        },
      ],
    }),
  });
}

export function scan(directory: string) {
  const scope = appScope();
  return scope.run(() =>
    scope
      .get(RpcClientService)
      .use(ExtHostRpcContract)
      .scanExtensions({ extensionsDir: directory }),
  );
}

export function removeExtension(extensionId: string) {
  const scope = appScope();
  return scope.run(() =>
    scope.get(RpcClientService).use(ExtHostRpcContract).removeContentExtension({ extensionId }),
  );
}

function activeEditor() {
  return (
    monaco.editor.getEditors().find((editor) => editor.hasTextFocus()) ??
    monaco.editor.getEditors()[0]
  );
}

function clientInternals() {
  return appScope().get(ExtensionHostClientService) as unknown as {
    active: { value?: { client: WorkspaceExtensionHostClient } };
    contributions: ClientContributions;
  };
}

export function suggest(text: string) {
  const editor = activeEditor()!;
  editor.setValue(text);
  editor.setPosition({ lineNumber: 1, column: text.length + 1 });
  editor.focus();
  editor.trigger("refresh-test", "editor.action.triggerSuggest", {});
}

export function snapshot() {
  const editor = activeEditor();
  const model = editor?.getModel();
  const contributions = activeContributions.value as ExtensionContributions | undefined;
  const client = clientInternals();
  const host = client.active.value?.client;
  return {
    session: host?.isReady ? host.id : undefined,
    generation: client.contributions.generation,
    language: model?.getLanguageId(),
    text: model?.getValue(),
    tokens: model
      ? monaco.editor
          .tokenize(model.getValue(), model.getLanguageId())
          .flat()
          .map((token) => token.type)
      : [],
    theme: contributions?.themeName,
    background: document.documentElement.style.getPropertyValue("--vscode-editor-background"),
    removedExtensionDefault: appScope().get(UiConfigService).get("fixture.contentRemoval", false),
    grammar: contributions?.registeredGrammars.get("groovy"),
    snippets:
      contributions?.snippets
        .filter((snippet) => snippet.language === "groovy")
        .map((snippet) => snippet.name) ?? [],
    iconStyles: [...document.querySelectorAll("style")].filter(
      (style) =>
        style.textContent?.includes("vscode-contribution-") &&
        style.textContent?.includes("@font-face"),
    ).length,
  };
}

let disposedContributions: ClientContributions | undefined;
let replacementQueue: Promise<void> | undefined;

export function unregisterClient(replace = false) {
  const scope = appScope();
  disposedContributions = clientInternals().contributions;
  if (replace) {
    scope.get(UiConfigService).set("workbench.colorTheme", "Monokai");
    scope.provide(ExtensionHostClientService);
    replacementQueue = clientInternals().contributions.queuedUpdate;
  } else scope.unprovide(ExtensionHostClientService);
}

export function replacementQueued() {
  return clientInternals().contributions.queuedUpdate !== replacementQueue;
}

export async function disposedState(replace = false) {
  await disposedContributions?.queuedUpdate;
  if (replace) await clientInternals().contributions.queuedUpdate;
  return {
    active: activeContributions.value !== undefined,
    background: document.documentElement.style.getPropertyValue("--vscode-editor-background"),
    iconStyles: [...document.querySelectorAll("style")].filter(
      (style) =>
        style.textContent?.includes("vscode-contribution-") &&
        style.textContent?.includes("@font-face"),
    ).length,
  };
}
