import { TabGroupsData, type TabGroupsSnapshot } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

export function createTabGroups(bridge: ExtHostBridge): TabGroupsData {
  const groups = new TabGroupsData(async (kind, ids, preserveFocus) =>
    Boolean(
      await bridge.callMain(
        kind === "tabs" ? "window.closeTabs" : "window.closeTabGroups",
        ids,
        preserveFocus,
      ),
    ),
  );
  bridge.commandHandlers.set("__win.syncTabGroups", (snapshot) =>
    groups.update(snapshot as TabGroupsSnapshot),
  );
  return groups;
}
