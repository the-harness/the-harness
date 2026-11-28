import type { UiStorageService } from "@harness/ui-storage";
import { z } from "zod";

export function createMainThreadMemento(storage: UiStorageService) {
  const state = storage.scope("vscode", "state").use("core:vscode-memento", {
    values: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  });
  return (sessionId: string, method: string, args: unknown[]) => {
    const [extensionId, scope, key, value, remove] = args as [
      string,
      string,
      string,
      unknown,
      boolean?,
    ];
    const bucket = JSON.stringify([scope === "global" ? "global" : sessionId, extensionId]);
    if (method === "memento.load") return state.values[bucket] ?? {};
    if (method === "memento.update") {
      const next = { ...state.values[bucket] };
      if (remove || value === undefined) delete next[key];
      else next[key] = value;
      state.values = { ...state.values, [bucket]: next };
    }
    return undefined;
  };
}
