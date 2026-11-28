import { Menu, MenuAction, MenuSubmenu } from "@harness/ui-menu";
import type { PanelDefinition, UiWorkbenchService } from "./workbench.ts";
import type { TabDirection, UiTabsService } from "./tabs.ts";
import type { IDockviewPanel } from "dockview-vue";

export type WorkbenchMenuTarget =
  | { readonly area: "titlebar" | "activityBar" | "statusbar" }
  | { readonly area: "view"; readonly panelId: string };

export type WorkbenchMenuContext = WorkbenchMenuTarget & {
  readonly region?: "left" | "right" | "below";
  readonly visibleRegions: ReadonlySet<string | undefined>;
  readonly visiblePanels: ReadonlySet<string>;
  readonly panels: readonly PanelDefinition[];
  readonly statusItems: readonly { readonly id: string; readonly name?: string; readonly text: string }[];
  readonly hiddenStatusItems: readonly string[];
  readonly sidebarShortcut: string;
  readonly toggleRegion: (region: "left" | "right" | "below") => void;
  readonly togglePanel: (id: string) => Promise<void>;
  readonly toggleStatusItem: (id: string) => Promise<void>;
  readonly setActivityBarPosition: (position: "default" | "top" | "bottom" | "hidden") => Promise<void>;
  readonly resetLayout: () => void;
};

export interface CodeMenuContext {
  readonly code: string;
  readonly language: string;
  readonly selection: string;
  readonly selectAll: () => void;
}

export function createActivityBarMenu(workbench: Pick<UiWorkbenchService, "activityBarLocation">) {
  return new Menu({
    position: (context: WorkbenchMenuContext) => ([
      { value: "default", label: "Default" },
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
      { value: "hidden", label: "Hidden" },
    ] as const).map((position) => new MenuAction({
      id: position.value, label: position.label, type: "radio",
      checked: workbench.activityBarLocation.value === position.value,
      run: () => context.setActivityBarPosition(position.value),
    })),
  });
}

export function createCodeMenu() {
  return new Menu({
    clipboard: (context: CodeMenuContext) => [
      new MenuAction({ id: "copy", label: "Copy", disabled: !context.selection, run: () => navigator.clipboard.writeText(context.selection) }),
      new MenuAction({ id: "copy-code", label: "Copy Code", disabled: !context.code, run: () => navigator.clipboard.writeText(context.code) }),
      new MenuAction({ id: "select-all", label: "Select All", run: context.selectAll }),
    ],
  });
}

export function createWorkbenchMenu(
  workbench: Pick<UiWorkbenchService, "sidebarLocation" | "toggleSidebarPosition">,
  activityBarMenu: Menu<WorkbenchMenuContext>,
) {
  return new Menu({
    views: (context: WorkbenchMenuContext) => {
      if (context.area === "statusbar") return context.statusItems.map((item) => new MenuAction({
        id: item.id, label: item.name ?? (item.text.replace(/\$\([^)]+\)/g, "").trim() || item.id),
        type: "checkbox", checked: !context.hiddenStatusItems.includes(item.id),
        run: () => context.toggleStatusItem(item.id),
      }));
      if (context.area === "titlebar") return [
        new MenuAction({ id: "primary", label: "Primary Side Bar", type: "checkbox", checked: context.visibleRegions.has("left"), run: () => context.toggleRegion("left") }),
        new MenuAction({ id: "secondary", label: "Secondary Side Bar", type: "checkbox", checked: context.visibleRegions.has("right"), run: () => context.toggleRegion("right") }),
        new MenuAction({ id: "panel", label: "Panel", type: "checkbox", checked: context.visibleRegions.has("below"), run: () => context.toggleRegion("below") }),
      ];
      if (context.area !== "view" || context.region === "left") return [];
      return context.panels.map((panel) => new MenuAction({
        id: panel.id, label: panel.title, type: "checkbox", checked: context.visiblePanels.has(panel.id),
        run: () => context.togglePanel(panel.id),
      }));
    },
    activity: (context: WorkbenchMenuContext) => context.area === "titlebar" || context.region === "left" ? [
      new MenuSubmenu<WorkbenchMenuContext>({ id: "activity-position", label: "Activity Bar Position", menu: activityBarMenu }),
    ] : [],
    position: (context: WorkbenchMenuContext) => context.region === "left" ? [
      new MenuAction({ id: "move-sidebar", label: workbench.sidebarLocation.value === "left" ? "Move Primary Side Bar Right" : "Move Primary Side Bar Left", run: () => workbench.toggleSidebarPosition() }),
    ] : [],
    visibility: (context: WorkbenchMenuContext) => {
      if (context.region === "left") return [
        new MenuAction({ id: "toggle-sidebar", label: context.visibleRegions.has("left") ? "Hide primary sidebar" : "Show primary sidebar", shortcut: context.sidebarShortcut, run: () => context.toggleRegion("left") }),
      ];
      if (context.area !== "view" || !context.region) return [];
      const region = context.region;
      return [new MenuAction({ id: "hide-region", label: region === "below" ? "Hide Panel" : "Hide Secondary Side Bar", run: () => context.toggleRegion(region) })];
    },
    reset: (context: WorkbenchMenuContext) => context.area === "titlebar" ? [
      new MenuAction({ id: "reset-layout", label: "Reset Layout", run: context.resetLayout }),
    ] : [],
  });
}

export interface TabMenuContext {
  readonly tabId: string;
  readonly afterClose?: () => void;
}

export function createTabMenu(
  tabs: Pick<UiTabsService, "groups" | "tabs" | "close" | "splitGroup">,
  getPanel: (id: string) => IDockviewPanel | undefined,
  moveMenu: Menu<TabMenuContext>,
) {
  return new Menu({
    close: (context: TabMenuContext) => {
      void tabs.groups.value;
      const panel = getPanel(context.tabId);
      if (!panel) return [];
      const ids = panel.group.panels.map((item) => item.id);
      const index = ids.indexOf(panel.id);
      const close = (targets: readonly string[]) => {
        targets.forEach((id) => tabs.close(id));
        context.afterClose?.();
      };
      return [
        new MenuAction({ id: "close", label: "Close", run: () => close([panel.id]) }),
        new MenuAction({ id: "close-others", label: "Close Others", disabled: ids.length < 2, run: () => close(ids.filter((id) => id !== panel.id)) }),
        new MenuAction({ id: "close-right", label: "Close to the Right", disabled: index === ids.length - 1, run: () => close(ids.slice(index + 1)) }),
        new MenuAction({ id: "close-left", label: "Close to the Left", disabled: index === 0, run: () => close(ids.slice(0, index)) }),
        new MenuAction({ id: "close-all", label: "Close All", run: () => close(ids) }),
      ];
    },
    layout: (context: TabMenuContext) => {
      void tabs.groups.value;
      const panel = getPanel(context.tabId);
      if (!panel) return [];
      const split = (direction: TabDirection) => {
        panel.api.setActive();
        tabs.splitGroup(panel.group.id, direction, { copyActiveTab: true });
      };
      return [
        new MenuAction({ id: "split-right", label: "Split Right", disabled: !tabs.tabs.has(panel.id), run: () => split("right") }),
        new MenuAction({ id: "split-down", label: "Split Down", disabled: !tabs.tabs.has(panel.id), run: () => split("down") }),
        new MenuSubmenu<TabMenuContext>({ id: "move", label: "Move into New Group", menu: moveMenu }),
      ];
    },
  });
}

export function createTabMoveMenu(
  tabs: Pick<UiTabsService, "groups" | "moveToNewGroup">,
  getPanel: (id: string) => IDockviewPanel | undefined,
) {
  return new Menu({
    directions: (context: TabMenuContext) => {
      void tabs.groups.value;
      const panel = getPanel(context.tabId);
      if (!panel) return [];
      return (["left", "right", "up", "down"] as const).map((direction) => new MenuAction({
        id: direction,
        label: direction[0]!.toUpperCase() + direction.slice(1),
        run: () => { tabs.moveToNewGroup(panel.id, panel.group.id, direction); },
      }));
    },
  });
}
