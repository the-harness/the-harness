import type { ExtHostBridge } from "./bridge.ts";
import { EventEmitter, Uri } from "./types.ts";

export interface ExtensionInfo {
  readonly id: string;
  readonly extensionPath: string;
  readonly isActive: boolean;
  readonly packageJSON: Record<string, unknown>;
  readonly extensionKind?: number;
  readonly exports?: unknown;
}

export function createExtensionsNamespace(bridge: ExtHostBridge) {
  const changeEmitter = new EventEmitter<void>();
  const registry = new Map<string, ExtensionInfo>();
  const wrappers = new Map<string, ReturnType<typeof wrap>>();
  const wrap = (key: string) => {
    let latest = registry.get(key)!;
    const current = () => {
      latest = registry.get(key) ?? latest;
      return latest;
    };
    return {
      get id() {
        return current().id;
      },
      get extensionPath() {
        return current().extensionPath;
      },
      get extensionUri() {
        return Uri.file(current().extensionPath);
      },
      get isActive() {
        return current().isActive;
      },
      get packageJSON() {
        return current().packageJSON;
      },
      get extensionKind() {
        return current().extensionKind ?? 2;
      },
      isFromDifferentExtensionHost: false,
      get exports() {
        return current().exports;
      },
      activate: async () => {
        if (!bridge.activateExtension) throw new Error("Extension activation is unavailable");
        return bridge.activateExtension(key);
      },
    };
  };
  bridge.commandHandlers.set("__ext.sync", (list: unknown) => {
    const previousIds = [...registry.keys()];
    registry.clear();
    for (const info of (list as ExtensionInfo[]) ?? []) {
      const key = info.id.toLowerCase();
      registry.set(key, info);
      if (!wrappers.has(key)) wrappers.set(key, wrap(key));
    }
    for (const key of wrappers.keys()) if (!registry.has(key)) wrappers.delete(key);
    if (previousIds.length !== registry.size || previousIds.some((id) => !registry.has(id)))
      changeEmitter.fire();
  });
  return {
    get all() {
      return [...wrappers.values()];
    },
    get allAcrossExtensionHosts() {
      return [...wrappers.values()];
    },
    getExtension(extensionId: string, _includeDifferentExtensionHosts?: boolean) {
      return wrappers.get(extensionId.toLowerCase());
    },
    onDidChange: changeEmitter.event,
  };
}
