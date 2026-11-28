import {
  createExtensionContributions,
  type ExtensionContributionSnapshot,
} from "@harness/vscode-editor-compat/contributions";
import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { RpcClientService } from "@harness/rpc";
import { UiConfigService } from "@harness/ui-config";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { ExtHostRpcContract } from "../../../packages/vscode-ext-host/src/rpc.ts";

let adapter: Awaited<ReturnType<typeof createExtensionContributions>>;
export async function installIcons(
  snapshots: ExtensionContributionSnapshot[],
  options?: { themeKind?: "dark" | "light" },
) {
  adapter?.dispose();
  adapter = await createExtensionContributions(snapshots, options);
}
export function selectIconTheme(id: string) {
  adapter.setIconTheme(id);
}
export function iconClass(
  path: string,
  options?: { folder?: boolean; expanded?: boolean; root?: boolean },
) {
  return adapter.getFileIconClass(path, options);
}
export async function inspectIcon(path: string) {
  const icon = document.createElement("span");
  icon.className = adapter.getFileIconClass(path)!;
  icon.style.cssText = "display:inline-block;width:24px;height:24px";
  document.body.appendChild(icon);
  const before = getComputedStyle(icon, "::before");
  await document.fonts.load(`16px ${before.fontFamily}`);
  const result = {
    content: before.content,
    font: before.fontFamily,
    fontSize: before.fontSize,
    loaded: document.fonts.check(`16px ${before.fontFamily}`),
    className: icon.className,
  };
  icon.remove();
  return result;
}

function appScope(): Scope {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!;
}

export async function scanAndRefresh(builtins: string, extensions: string) {
  const scope = appScope();
  const rpc = scope.run(() => scope.get(RpcClientService).use(ExtHostRpcContract));
  const official = await rpc.scanExtensions({ extensionsDir: builtins });
  const custom = await rpc.scanExtensions({ extensionsDir: extensions });
  await scope.get(ExtensionHostClientService).refreshContributions();
  return {
    official: official.map((manifest) => manifest.id),
    custom: custom.map((manifest) => manifest.id),
  };
}

export function configureAppearance(color: string, icon: string) {
  const config = appScope().get(UiConfigService);
  config.set("workbench.colorTheme", color, "workspace");
  config.set("workbench.iconTheme", icon, "workspace");
}
