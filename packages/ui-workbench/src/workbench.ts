import { createRootScope, inject } from "@harness/di";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import type { DockviewApi } from "dockview-vue";
import {
  markRaw,
  onScopeDispose,
  ref,
  shallowReactive,
  shallowReadonly,
  toRef,
  type Component,
  type Ref,
} from "vue";
import { z } from "zod";
import { UiTabsService } from "./tabs.ts";
import { createActivityBarMenu, createCodeMenu, createWorkbenchMenu } from "./menus.ts";

export type { WorkbenchMenuTarget, WorkbenchMenuContext, CodeMenuContext } from "./menus.ts";

export interface PanelDefinition {
  id: string;
  title: string;
  icon: string;
  component: Component;
  location: "left" | "right" | "below" | "within";
  presentation?: "editor" | "view";
  titleActions?: WorkbenchAction[];
}

export interface WorkbenchAction {
  id: string;
  title: string;
  icon: string;
  shortcut?: string;
  isActive?: () => boolean;
  run: () => void;
}

export interface WorkbenchExtension {
  id: string;
  panels?: PanelDefinition[];
  commands?: WorkbenchAction[];
}

export class UiWorkbenchService {
  readonly activityBarMenu = createActivityBarMenu(this);
  readonly codeMenu = createCodeMenu();
  readonly menu = createWorkbenchMenu(this, this.activityBarMenu);
  private readonly registeredExtensions = shallowReactive(new Map<string, WorkbenchExtension>());
  readonly extensions: ReadonlyMap<string, WorkbenchExtension> = shallowReadonly(
    this.registeredExtensions,
  );
  readonly theme: Ref<"dark" | "light">;
  readonly sidebarLocation: Ref<"left" | "right">;
  readonly activityBarLocation: Ref<"default" | "top" | "bottom" | "hidden">;

  private readonly tabsService = inject(UiTabsService);
  private dock: DockviewApi | undefined;
  private lastLeftViewId = "sessions";
  private readonly savedGroups = new Map<
    string,
    {
      serialized: ReturnType<DockviewApi["serializeGroup"]>;
      size: { width?: number; height?: number };
    }
  >();

  constructor() {
    const prefs = createWorkbenchPreferences(inject(UiStorageService));
    this.theme = prefs.theme;
    this.sidebarLocation = prefs.sidebarLocation;
    this.activityBarLocation = prefs.activityBarLocation;
  }

  use(extension: WorkbenchExtension): void {
    const raw = markRaw(extension);
    this.registeredExtensions.set(extension.id, raw);
    onScopeDispose(() => {
      if (this.extensions.get(extension.id) !== raw) return;
      extension.panels?.forEach(({ id }) => this.dock?.getPanel(id)?.api.close());
      this.registeredExtensions.delete(extension.id);
    });
  }

  panels(): PanelDefinition[] {
    return [...this.extensions.values()].flatMap((item) => item.panels ?? []);
  }

  open(id: string): void {
    const dock = this.dock;
    if (!dock) return;
    const panel = this.panels().find((item) => item.id === id);
    if (panel?.presentation === "view" && panel.location === "left") {
      this.lastLeftViewId = id;
    }
    const existing = dock.getPanel(id);
    if (existing) {
      if (existing.group && existing.group.api.isVisible === false) {
        existing.group.api.setVisible(true);
      }
      existing.api.setActive();
      return;
    }
    if (this.restoreGroup(id)) return;
    if (!panel) return;
    const allDefinitions = this.panels();
    if (panel.presentation === "view" && panel.location === "left") {
      const existingLeftView = dock.panels.find((item) => {
        const definition = allDefinitions.find((view) => view.id === item.id);
        return definition?.presentation === "view" && definition.location === "left";
      });
      if (existingLeftView?.group) {
        const group = existingLeftView.group;
        if (!group.api.isVisible) group.api.setVisible(true);
        const width = group.api.width;
        const height = group.api.height;
        const otherPanels = group.panels.filter((item) => item.id !== existingLeftView.id);
        dock.addPanel({
          id,
          title: panel.title,
          component: "extension",
          params: { panelId: id },
          position: { referenceGroup: group.id, direction: "within" },
          minimumWidth: 200,
          minimumHeight: 90,
        });
        existingLeftView.api.close();
        otherPanels.forEach((item) => item.api.close());
        group.api.setSize({
          width: width > 0 ? width : undefined,
          height: height > 0 ? height : undefined,
        });
        return;
      }
    }
    const editorPanel =
      dock.getPanel("chat") ??
      dock.panels.find(
        (item) =>
          allDefinitions.find((definition) => definition.id === item.id)?.presentation !== "view",
      );
    const matchingViewPanel =
      panel.presentation === "view" && panel.location !== "left"
        ? dock.panels.find((item) => {
            const definition = allDefinitions.find((view) => view.id === item.id);
            return (
              definition?.presentation === "view" &&
              this.viewRegion(definition.location) === this.viewRegion(panel.location)
            );
          })
        : undefined;
    if (matchingViewPanel?.group && matchingViewPanel.group.api.isVisible === false) {
      matchingViewPanel.group.api.setVisible(true);
    }
    const rightEditorPanel =
      panel.presentation !== "view" && panel.location === "right"
        ? dock.panels.find((item) => {
            const definition = allDefinitions.find((view) => view.id === item.id);
            return definition?.location === "right" && definition.presentation !== "view";
          })
        : undefined;
    const position = matchingViewPanel
      ? { referencePanel: matchingViewPanel.id, direction: "within" as const }
      : rightEditorPanel
        ? { referencePanel: rightEditorPanel.id, direction: "within" as const }
        : panel.presentation === "view"
          ? { direction: this.resolvedDirection(panel.location) }
          : dock.width < 900 && editorPanel
            ? {
                referencePanel: editorPanel.id,
                direction: "within" as const,
              }
            : panel.location === "left"
              ? { direction: "left" as const }
              : editorPanel
                ? { referencePanel: editorPanel.id, direction: panel.location }
                : { direction: "right" as const };
    const sidebarWidths = this.captureSidebarWidths();
    dock.addPanel({
      id,
      title: panel.title,
      component: "extension",
      params: { panelId: id },
      position,
      initialWidth: panel.location === "left" ? 250 : 310,
      initialHeight: 190,
      minimumWidth: id === "chat" ? 300 : panel.location === "left" ? 200 : 180,
      minimumHeight: 90,
    });
    this.restoreSidebarWidths(sidebarWidths);
  }

  toggle(id: string, requireActiveGroup = false): void {
    const dock = this.dock;
    if (!dock) return;
    if (dock.getPanel(id)?.group?.api.isVisible === false) {
      this.open(id);
      return;
    }
    const definition = this.panels().find((item) => item.id === id);
    const location = definition ? this.viewRegion(definition.location) : "right";
    if (definition?.presentation === "view" && definition.location === "left") {
      const existingLeftView = dock.panels.find((item) => {
        const def = this.panels().find((view) => view.id === item.id);
        return def?.presentation === "view" && def.location === "left";
      });
      if (existingLeftView) {
        const group = existingLeftView.group;
        if (existingLeftView.id === id) {
          if (requireActiveGroup && group && dock.activeGroup !== group) {
            existingLeftView.api.setActive();
            return;
          }
          this.lastLeftViewId = id;
          if (group) group.api.setVisible(false);
          else existingLeftView.api.close();
          return;
        }
        this.open(id);
        return;
      }
      this.open(id);
      return;
    }
    const panel = dock.getPanel(id);
    if (panel) {
      const group = panel.group;
      if (
        !group ||
        (group.activePanel?.id === id && (!requireActiveGroup || dock.activeGroup === group))
      ) {
        if (group && definition?.presentation === "view") {
          group.api.setVisible(false);
        } else if (group && typeof dock.serializeGroup === "function") {
          const sidebarWidths = this.captureSidebarWidths(group.id);
          this.savedGroups.set(location, {
            serialized: dock.serializeGroup(group),
            size: { width: group.api.width, height: group.api.height },
          });
          group.api.close();
          this.restoreSidebarWidths(sidebarWidths);
        } else {
          panel.api.close();
        }
        return;
      }
      panel.api.setActive();
      return;
    }
    this.open(id);
  }

  toggleLeftSidebar(): void {
    const dock = this.dock;
    if (!dock) return;
    const existingLeftView = dock.panels.find((item) => {
      const def = this.panels().find((view) => view.id === item.id);
      return def?.presentation === "view" && def.location === "left";
    });
    if (existingLeftView) {
      this.toggle(existingLeftView.id);
    } else {
      this.open(this.lastLeftViewId);
    }
  }

  setSidebarPosition(side: "left" | "right"): void {
    if (this.sidebarLocation.value === side) return;
    this.sidebarLocation.value = side;
    const dock = this.dock;
    if (!dock || typeof dock.serializeGroup !== "function") return;
    const allDefinitions = this.panels();
    const isPrimaryView = (id: string) => {
      const def = allDefinitions.find((view) => view.id === id);
      return def?.presentation === "view" && def.location === "left";
    };
    const isAuxiliaryView = (id: string) => {
      const def = allDefinitions.find((view) => view.id === id);
      return (
        def?.presentation === "view" && (def.location === "right" || def.location === "within")
      );
    };
    const primaryPanel = dock.panels.find((item) => isPrimaryView(item.id));
    const auxiliaryPanel = dock.panels.find((item) => isAuxiliaryView(item.id));
    const primaryGroup = primaryPanel?.group;
    const auxiliaryGroup =
      auxiliaryPanel?.group && auxiliaryPanel.group !== primaryGroup
        ? auxiliaryPanel.group
        : undefined;
    const activePanelId = dock.activePanel?.id;
    const primarySnap = primaryGroup
      ? {
          serialized: dock.serializeGroup(primaryGroup),
          width: primaryGroup.api.width || 250,
          visible: primaryGroup.api.isVisible,
        }
      : undefined;
    const auxiliarySnap = auxiliaryGroup
      ? {
          serialized: dock.serializeGroup(auxiliaryGroup),
          width: auxiliaryGroup.api.width || 290,
          visible: auxiliaryGroup.api.isVisible,
        }
      : undefined;
    primaryGroup?.api.close();
    auxiliaryGroup?.api.close();
    if (auxiliarySnap) {
      const restoredAux = dock.addGroupFromJSON(auxiliarySnap.serialized, {
        direction: side === "left" ? "right" : "left",
        initialWidth: auxiliarySnap.width,
      });
      restoredAux.api.setSize({ width: auxiliarySnap.width });
      if (!auxiliarySnap.visible) restoredAux.api.setVisible(false);
    }
    if (primarySnap) {
      const restoredPrimary = dock.addGroupFromJSON(primarySnap.serialized, {
        direction: side,
        initialWidth: primarySnap.width,
      });
      restoredPrimary.api.setSize({ width: primarySnap.width });
      if (!primarySnap.visible) restoredPrimary.api.setVisible(false);
    }
    if (activePanelId) dock.getPanel(activePanelId)?.api.setActive();
  }

  toggleSidebarPosition(): void {
    this.setSidebarPosition(this.sidebarLocation.value === "left" ? "right" : "left");
  }

  clearSavedGroups(): void {
    this.savedGroups.clear();
  }

  attach(api: DockviewApi): void {
    this.dock = api;
    this.savedGroups.clear();
    this.tabsService.attach(api);
  }

  private captureSidebarWidths(
    excludeGroupId?: string,
  ): Array<{ group: DockviewApi["groups"][number]; width: number }> {
    const dock = this.dock;
    if (!dock) return [];
    const allDefinitions = this.panels();
    const result: Array<{ group: DockviewApi["groups"][number]; width: number }> = [];
    for (const group of dock.groups) {
      if (group.id === excludeGroupId || !group.api.isVisible) continue;
      const isHorizontalSidebar = group.panels.some((panel) => {
        const def = allDefinitions.find((view) => view.id === panel.id);
        if (def?.presentation !== "view") return false;
        const region = this.viewRegion(def.location);
        return region === "left" || region === "right";
      });
      if (isHorizontalSidebar && group.api.width > 0) {
        result.push({ group, width: group.api.width });
      }
    }
    return result;
  }

  private restoreSidebarWidths(
    snapshots: Array<{ group: DockviewApi["groups"][number]; width: number }>,
  ): void {
    for (const { group, width } of snapshots) {
      group.api.setSize({ width });
    }
  }

  private viewRegion(location: PanelDefinition["location"]) {
    return location === "within" ? "right" : location;
  }

  private resolvedDirection(location: PanelDefinition["location"]): "left" | "right" | "below" {
    const region = this.viewRegion(location);
    if (region === "below") return "below";
    const primarySide = this.sidebarLocation.value === "right" ? "right" : "left";
    const auxiliarySide = primarySide === "left" ? "right" : "left";
    return region === "left" ? primarySide : auxiliarySide;
  }

  private restoreGroup(id: string): boolean {
    const dock = this.dock;
    if (!dock) return false;
    const definition = this.panels().find((item) => item.id === id);
    if (definition?.presentation !== "view") return false;
    const location = this.viewRegion(definition.location);
    const saved = this.savedGroups.get(location);
    if (!saved || typeof dock.addGroupFromJSON !== "function") return false;
    this.savedGroups.delete(location);
    try {
      const sidebarWidths = this.captureSidebarWidths();
      const direction = this.resolvedDirection(definition.location);
      const restored = dock.addGroupFromJSON(saved.serialized, {
        direction,
        initialWidth: saved.size.width ?? (location === "left" ? 250 : 290),
        initialHeight: saved.size.height ?? 190,
      });
      restored.api.setSize({
        width: direction === "left" || direction === "right" ? saved.size.width : undefined,
        height: direction === "below" ? saved.size.height : undefined,
      });
      this.restoreSidebarWidths(sidebarWidths);
      const existing = dock.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return true;
      }
      if (location === "left") {
        const currentLeft = restored.panels[0];
        if (currentLeft && currentLeft.id !== id) {
          this.open(id);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  readonly themeName = ref<string | undefined>(undefined);
  private readonly fileIconResolvers = new Set<FileIconResolver>();

  setThemeName(name: string | undefined): void {
    this.themeName.value = name;
  }

  registerFileIconResolver(resolver: FileIconResolver): () => void {
    this.fileIconResolvers.add(resolver);
    return () => {
      this.fileIconResolvers.delete(resolver);
    };
  }

  getFileIconClass(
    name: string,
    options?: { isDir?: boolean; isExpanded?: boolean },
  ): string | undefined {
    for (const resolver of this.fileIconResolvers) {
      const result = resolver(name, options);
      if (result) return result;
    }
    return undefined;
  }
}

export type FileIconResolver = (
  name: string,
  options?: { isDir?: boolean; isExpanded?: boolean },
) => string | undefined;

function createWorkbenchPreferences(storage: UiStorageService) {
  const themeSchema = z.enum(["dark", "light"]);
  const sidebarLocationSchema = z.enum(["left", "right"]);
  const legacy = storage.use("core:ui-workbench", {
    theme: themeSchema.default("dark"),
    sidebarLocation: sidebarLocationSchema.default("left"),
  });
  const theme = storage.use(
    "core:ui-workbench:theme",
    { theme: themeSchema.default(legacy.theme) },
    new CrossTabSync(),
  );
  const sidebar = storage.use(
    "core:ui-workbench:sidebar-location",
    { sidebarLocation: sidebarLocationSchema.default(legacy.sidebarLocation) },
    new CrossTabSync(),
  );
  const activityBar = storage.use(
    "core:ui-workbench:activity-bar-location",
    { activityBarLocation: z.enum(["default", "top", "bottom", "hidden"]).default("default") },
    new CrossTabSync(),
  );
  return {
    theme: toRef(theme, "theme"),
    sidebarLocation: toRef(sidebar, "sidebarLocation"),
    activityBarLocation: toRef(activityBar, "activityBarLocation"),
  };
}

export function createWorkbench(): UiWorkbenchService {
  const scope = createRootScope();
  scope.provideAll([UiStorageService, UiTabsService, UiWorkbenchService]);
  return scope.get(UiWorkbenchService);
}
