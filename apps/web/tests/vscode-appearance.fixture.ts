import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { RpcClientService } from "@harness/rpc";
import { UiConfigService } from "@harness/ui-config";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { Uri, VscodeWindowCompatService } from "@harness/vscode-editor-compat";
import { activeContributions } from "@harness/vscode-editor-compat/contribution-state";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function loadThemes(directory: string) {
  const scope = appScope();
  const scanned = await scope.run(() =>
    scope
      .get(RpcClientService)
      .use(ExtHostRpcContract)
      .scanExtensions({ extensionsDir: directory }),
  );
  if (!scanned.some((extension) => extension.id === "vscode.theme-monokai"))
    throw new Error("Official Monokai was not scanned");
  await scope.get(ExtensionHostClientService).refreshContributions();
}

export async function openDocument(root: string) {
  const scope = appScope();
  scope.get(UiWorkspaceService).addRoot(root);
  await scope.get(VscodeWindowCompatService).showTextDocument(Uri.file(`${root}/appearance.ts`));
}

export function snapshot() {
  const config = appScope().get(UiConfigService);
  return {
    selectedTheme: config.get("workbench.colorTheme"),
    selectedIcons: config.get("workbench.iconTheme"),
    appliedTheme: activeContributions.value?.themeName,
  };
}
