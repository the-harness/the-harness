import type { Scope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { UiSessionsService } from "@harness/ui-sessions";
import { scopeKey } from "@harness/ui-di";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import * as monaco from "monaco-editor";
import type { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

function rpc(scope: Scope) {
  return scope.run(() => scope.get(RpcClientService).use(ExtHostRpcContract));
}

export async function scanAndOpen(root: string, extensionsDir: string, newWorkspace = false) {
  const scope = appScope();
  await rpc(scope).scanExtensions({ extensionsDir });
  const workspace = scope.get(UiWorkspaceService);
  if (newWorkspace) {
    const opened = workspace.createWorkspace({ folders: [root] });
    scope.get(UiSessionsService).newSession(opened.id);
  } else {
    workspace.addRoot(root);
  }
}

export function activeHost(workspaceRoot?: string): string | undefined {
  const client = appScope().get(ExtensionHostClientService) as unknown as {
    active: { value?: { client: WorkspaceExtensionHostClient } };
  };
  const host = client.active.value?.client;
  if (!host?.isReady) return undefined;
  if (workspaceRoot && (host.roots.length !== 1 || host.roots[0] !== workspaceRoot))
    return undefined;
  return host.id;
}

export function execute(sessionId: string, command: string, args: unknown[]) {
  return rpc(appScope()).executeCommand({ sessionId, command, args });
}

export function modelValue(uri: string): string | undefined {
  return monaco.editor.getModel(monaco.Uri.parse(uri))?.getValue();
}

export function modelLanguage(uri: string): string | undefined {
  return monaco.editor.getModel(monaco.Uri.parse(uri))?.getLanguageId();
}
