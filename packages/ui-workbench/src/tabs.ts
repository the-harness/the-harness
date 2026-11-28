import { createDescriptor, CurrentScope, inject, type Scope } from "@harness/di";
import { UiStorageService } from "@harness/ui-storage";
import { ExtensibleVariants, type VariantConstructor } from "@harness/variants";
import type { DockviewApi, IDockviewPanel } from "dockview-vue";
import {
  computed,
  effectScope,
  markRaw,
  getCurrentScope,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  watchSyncEffect,
  type Component,
} from "vue";
import { z } from "zod";
import type { WorkbenchAction } from "./workbench.ts";
import { createTabMenu, createTabMoveMenu } from "./menus.ts";

export type { TabMenuContext } from "./menus.ts";

export type TabDirection = "left" | "right" | "up" | "down";

export abstract class TabDescriptor extends ExtensibleVariants<{
  pinned?: boolean;
}> {
  abstract get key(): string;
  abstract get defaultTitle(): string;

  pinned = false;
}

export interface TabRenderer<T extends TabDescriptor = TabDescriptor> {
  descriptor: VariantConstructor<T>;
  component: Component;
  icon?: string | ((descriptor: T) => string);
  titleActions?: WorkbenchAction[];
  location?: "left" | "right" | "below" | "within";
}

export interface TabInstance<T extends TabDescriptor = TabDescriptor> {
  readonly tabId: string;
  readonly descriptor: T;
  readonly scope: Scope;
  title: string;
  dirty: boolean;
  pinned: boolean;
}

export interface TabGroupSnapshot {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly pinnedTabIds: readonly string[];
  readonly activeTabId: string | undefined;
  readonly isActive: boolean;
  readonly hasForeignPanels: boolean;
}

export interface OpenTabOptions {
  groupId?: string;
  split?: {
    direction: TabDirection;
    referenceGroupId?: string;
  };
  preserveFocus?: boolean;
  pinned?: boolean;
  reuseExisting?: boolean;
}

export interface TabPosition {
  groupId: string;
  index: number;
}

export class TabContext<T extends TabDescriptor = TabDescriptor> {
  constructor(readonly tab: TabInstance<T>) {}

  get descriptor(): T {
    return this.tab.descriptor;
  }
}

export class UiTabsService {
  readonly moveMenu = createTabMoveMenu(this, (id) => this.dock?.getPanel(id));
  readonly menu = createTabMenu(this, (id) => this.dock?.getPanel(id), this.moveMenu);

  readonly tabs = shallowReactive(new Map<string, TabInstance>());
  private readonly groupSnapshots = shallowRef<readonly TabGroupSnapshot[]>([]);
  readonly groups = computed(() => this.groupSnapshots.value);

  private readonly parentScope = inject(CurrentScope);
  private readonly storage = inject(UiStorageService);
  private readonly tabMemory = this.storage.use("core:ui-workbench:tab-positions", {
    positions: z
      .record(z.string(), z.object({ groupId: z.string(), index: z.number() }))
      .default({}),
  });
  private readonly renderers = shallowReactive(
    new Map<VariantConstructor<any>, { readonly renderer: TabRenderer<any> }>(),
  );
  private dock: DockviewApi | undefined;
  private dockDisposables: Array<{ dispose(): void }> = [];
  private tabCounter = 0;
  private groupSyncQueued = false;

  constructor() {
    onScopeDispose(() => {
      this.dockDisposables.forEach((disposable) => disposable.dispose());
      this.dockDisposables = [];
      this.dock = undefined;
      this.groupSnapshots.value = [];
    });
  }

  private syncGroups(): void {
    this.groupSnapshots.value = Object.freeze(
      (this.dock?.groups ?? []).map((group) =>
        Object.freeze({
          id: group.id,
          tabIds: Object.freeze(
            group.panels.filter((panel) => this.tabs.has(panel.id)).map((panel) => panel.id),
          ),
          pinnedTabIds: Object.freeze(
            group.panels
              .filter((panel) => this.tabs.has(panel.id) && panel.api.isPinned)
              .map((panel) => panel.id),
          ),
          activeTabId:
            group.activePanel && this.tabs.has(group.activePanel.id)
              ? group.activePanel.id
              : undefined,
          isActive: this.dock?.activeGroup === group,
          hasForeignPanels: group.panels.some((panel) => !this.tabs.has(panel.id)),
        }),
      ),
    );
  }

  private scheduleGroupSync = (): void => {
    if (this.groupSyncQueued) return;
    this.groupSyncQueued = true;
    queueMicrotask(() => {
      this.groupSyncQueued = false;
      this.syncGroups();
    });
  };

  useRenderer<T extends TabDescriptor>(renderer: TabRenderer<T>): void {
    if (!getCurrentScope()?.active) {
      throw new Error("useRenderer() requires an active EffectScope");
    }
    const { descriptor } = renderer;
    const registration = { renderer: markRaw(renderer) };
    onScopeDispose(() => {
      if (this.renderers.get(descriptor) === registration) {
        this.renderers.delete(descriptor);
      }
    });
    this.renderers.set(descriptor, registration);
  }

  // Tabs whose initialization ran, per key.
  readonly #initialized = new WeakMap<TabInstance, Set<string>>();

  /** Runs fn in the tab's scope once per tab and key, e.g. for views binding a restored tab. */
  runOnce(tab: TabInstance<any>, key: string, fn: () => void): void {
    let keys = this.#initialized.get(tab);
    if (keys === undefined) {
      keys = new Set();
      this.#initialized.set(tab, keys);
    }
    if (keys.has(key)) return;
    keys.add(key);
    tab.scope.run(() => {
      const scope = effectScope();
      try {
        scope.run(fn);
      } catch (error) {
        scope.stop();
        keys.delete(key);
        throw error;
      }
    });
  }

  get(tabId: string): TabInstance | undefined {
    return this.tabs.get(tabId);
  }

  getRenderer(descriptor: TabDescriptor): TabRenderer | undefined {
    let proto: unknown = descriptor.constructor;
    while (proto && proto !== ExtensibleVariants) {
      const found = this.renderers.get(proto as VariantConstructor<any>);
      if (found) return found.renderer;
      proto = Object.getPrototypeOf(proto);
    }
    return undefined;
  }

  open<T extends TabDescriptor>(descriptor: T, options?: OpenTabOptions): TabInstance<T> {
    if (options?.reuseExisting !== false) {
      for (const existing of this.tabs.values()) {
        if (existing.descriptor.key === descriptor.key) {
          const panel = this.dock?.getPanel(existing.tabId);
          if (panel && !options?.preserveFocus) {
            if (panel.group && panel.group.api.isVisible === false) {
              panel.group.api.setVisible(true);
            }
            panel.api.setActive();
          }
          return existing as TabInstance<T>;
        }
      }
    }

    const tabId = `tab-${++this.tabCounter}`;
    const scope = this.parentScope.createChild({ id: `tab:${tabId}` });
    const tab: TabInstance<T> = shallowReactive({
      tabId,
      descriptor,
      scope,
      title: descriptor.defaultTitle,
      dirty: false,
      pinned: options?.pinned ?? descriptor.pinned,
    });
    scope.provide(TabContext, createDescriptor(TabContext, tab));
    this.tabs.set(tabId, tab);

    const dock = this.dock;
    if (dock) {
      const position = this.resolveTabPosition(descriptor, options);
      dock.addPanel({
        id: tabId,
        title: tab.title,
        component: "extension",
        params: {
          tabId,
          input: ExtensibleVariants.serialize(descriptor),
        },
        position,
        inactive: options?.preserveFocus,
        minimumWidth: 200,
        minimumHeight: 90,
      });
    }

    scope.run(() => {
      watchSyncEffect(() => {
        const title = tab.title;
        this.dock?.getPanel(tabId)?.api.setTitle(title);
      });
    });

    return tab;
  }

  splitGroup(
    groupId: string,
    direction: TabDirection,
    options?: { copyActiveTab?: boolean },
  ): string | undefined {
    const dock = this.dock;
    if (!dock) return undefined;
    const sourceGroup = dock.getGroup(groupId);
    if (!sourceGroup) return undefined;

    const newGroup = dock.addGroup({
      referenceGroup: groupId,
      direction: this.toDockDirection(direction),
    });

    if (options?.copyActiveTab && sourceGroup.activePanel) {
      const activeTab = this.tabs.get(sourceGroup.activePanel.id);
      if (activeTab) {
        const cloned = ExtensibleVariants.deserialize(
          ExtensibleVariants.serialize(activeTab.descriptor),
        ) as TabDescriptor;
        this.open(cloned, { groupId: newGroup.id, reuseExisting: false });
      }
    }

    return newGroup.id;
  }

  move(tabId: string, targetGroupId: string, index?: number): void {
    const dock = this.dock;
    if (!dock) return;
    const panel = dock.getPanel(tabId);
    const targetGroup = dock.getGroup(targetGroupId);
    if (!panel || !targetGroup) return;
    panel.api.moveTo({ group: targetGroup, index });
    this.recordPanelPosition(panel);
  }

  moveToNewGroup(
    tabId: string,
    referenceGroupId: string,
    direction: TabDirection,
  ): string | undefined {
    const dock = this.dock;
    if (!dock) return undefined;
    const panel = dock.getPanel(tabId);
    const referenceGroup = dock.getGroup(referenceGroupId);
    if (!panel || !referenceGroup) return undefined;
    const newGroup = dock.addGroup({
      referenceGroup: referenceGroupId,
      direction: this.toDockDirection(direction),
    });
    panel.api.moveTo({ group: newGroup });
    this.recordPanelPosition(panel);
    return newGroup.id;
  }

  close(tabId: string): void {
    const panel = this.dock?.getPanel(tabId);
    if (panel) {
      panel.api.close();
      return;
    }
    this.disposeTab(tabId);
  }

  closeGroup(groupId: string): void {
    this.dock?.getGroup(groupId)?.api.close();
  }

  focusGroup(groupId: string): void {
    const group = this.dock?.getGroup(groupId);
    if (!group) return;
    if (group.api.isVisible === false) {
      group.api.setVisible(true);
    }
    group.activePanel?.api.setActive();
  }

  attach(api: DockviewApi): void {
    this.dockDisposables.forEach((d) => d.dispose());
    this.dockDisposables = [];
    this.dock = api;
    this.syncGroups();

    this.dockDisposables.push(
      api.onDidLayoutChange(this.scheduleGroupSync),
      api.onDidActivePanelChange(this.scheduleGroupSync),
      api.onDidActiveGroupChange(this.scheduleGroupSync),
      api.onDidAddPanel(this.scheduleGroupSync),
      api.onDidAddGroup(this.scheduleGroupSync),
      api.onDidRemoveGroup(this.scheduleGroupSync),
      api.onDidPanelPinnedChange(this.scheduleGroupSync),
      api.onDidMovePanel((event) => {
        this.recordPanelPosition(event.panel);
        this.scheduleGroupSync();
      }),
      api.onDidRemovePanel((panel) => {
        this.recordPanelPosition(panel);
        this.disposeTab(panel.id);
        this.scheduleGroupSync();
      }),
    );
  }

  private disposeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    tab.scope.dispose();
  }

  private recordPanelPosition(panel: IDockviewPanel): void {
    const tab = this.tabs.get(panel.id);
    if (!tab || !panel.group) return;
    const index = panel.group.panels.indexOf(panel);
    if (index < 0) return;
    const next: TabPosition = { groupId: panel.group.id, index };
    this.tabMemory.positions = {
      ...this.tabMemory.positions,
      [tab.descriptor.key]: next,
    };
  }

  private resolveTabPosition(
    descriptor: TabDescriptor,
    options?: OpenTabOptions,
  ): Parameters<DockviewApi["addPanel"]>[0]["position"] {
    const dock = this.dock;
    if (!dock) return undefined;

    if (options?.groupId && dock.getGroup(options.groupId)) {
      return { referenceGroup: options.groupId, direction: "within" };
    }
    const renderer = this.getRenderer(descriptor);
    if (!options?.split && renderer?.location === "within") {
      const chatGroupId = dock.getPanel("chat")?.group.id;
      if (chatGroupId) {
        return { referenceGroup: chatGroupId, direction: "within" };
      }
    }
    if (options?.split) {
      const refGroupId = options.split.referenceGroupId ?? dock.activeGroup?.id;
      if (refGroupId && dock.getGroup(refGroupId)) {
        return {
          referenceGroup: refGroupId,
          direction: this.toDockDirection(options.split.direction),
        };
      }
    }
    const remembered = this.tabMemory.positions[descriptor.key];
    if (remembered && dock.getGroup(remembered.groupId)) {
      return {
        referenceGroup: remembered.groupId,
        direction: "within",
        index: remembered.index,
      };
    }
    if (dock.activeGroup) {
      return { referenceGroup: dock.activeGroup.id, direction: "within" };
    }
    return undefined;
  }

  private toDockDirection(direction: TabDirection): "left" | "right" | "above" | "below" {
    return direction === "up" ? "above" : direction === "down" ? "below" : direction;
  }
}
