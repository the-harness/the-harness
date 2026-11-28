```ts
defineUiSlot<TProps extends object = Record<string, never>>(): UiSlot<TProps>
const ChatHeaderSlot: UiSlot<{ readonly sessionId?: string }>
const ChatInputNotificationSlot: UiSlot<{ readonly sessionId?: string }>
const ChatComposerSlot: UiSlot<{ readonly sessionId?: string }>
const StatusBarSlot: UiSlot
const ViewProgressSlot: UiSlot<{ readonly viewId: string }> // Workbench view header progress.
const SettingsSlot: UiSlot
const AppearanceSettingsSlot: UiSlot // Appearance controls; the default slot renders the built-in fallback.
const SettingsPanel: Component<{
  inDialog?: boolean; // Renders under the dialog's own title.
  onReset?: () => void;
  onSidebarSide?: (side: "left" | "right") => void;
}>

abstract class TabDescriptor extends ExtensibleVariants<{ pinned?: boolean }> {
  abstract get key(): string;
  abstract get defaultTitle(): string;
  pinned: boolean;
}

class TabContext<T extends TabDescriptor = TabDescriptor> {
  readonly tab: TabInstance<T>;
  readonly descriptor: T;
}

class UiTabsService {
  readonly moveMenu: Menu<TabMenuContext, "directions">; // 移动到新分组子菜单
  readonly menu: Menu<TabMenuContext, "close" | "layout">; // 标签页菜单；目标由打开菜单时的 tabId 决定
  readonly tabs: Map<string, TabInstance>;
  readonly groups: ComputedRef<readonly TabGroupSnapshot[]>; // Live Dockview groups, active tabs and pinned panel IDs.
  useRenderer<T extends TabDescriptor>(renderer: TabRenderer<T>): void; // 在当前 EffectScope 中注册 tab 渲染器，随 Scope 自动注销
  get(tabId: string): TabInstance | undefined;
  getRenderer(descriptor: TabDescriptor): TabRenderer | undefined;
  open<T extends TabDescriptor>(descriptor: T, options?: OpenTabOptions): TabInstance<T>; // 打开或复用 Tab，支持分栏、位置记忆与独立 DI Scope
  runOnce(tab: TabInstance, key: string, fn: () => void): void; // 在 Tab Scope 内按 (tab, key) 只执行一次
  splitGroup(groupId: string, direction: TabDirection, options?: { copyActiveTab?: boolean }): string | undefined;
  move(tabId: string, targetGroupId: string, index?: number): void;
  moveToNewGroup(tabId: string, referenceGroupId: string, direction: TabDirection): string | undefined;
  close(tabId: string): void;
  closeGroup(groupId: string): void;
  focusGroup(groupId: string): void;
  attach(api: DockviewApi): void;
}

interface TabMenuContext {
  readonly tabId: string;
  readonly afterClose?: () => void; // 关闭动作完成后恢复视图焦点
}

type WorkbenchMenuTarget =
  | { readonly area: "titlebar" | "activityBar" | "statusbar" }
  | { readonly area: "view"; readonly panelId: string };

type WorkbenchMenuContext = WorkbenchMenuTarget & {
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

interface CodeMenuContext {
  readonly code: string;
  readonly language: string;
  readonly selection: string;
  readonly selectAll: () => void;
}

class UiWorkbenchService {
  readonly codeMenu: Menu<CodeMenuContext, "clipboard">; // Scoped menus for read-only code blocks.
  readonly activityBarMenu: Menu<WorkbenchMenuContext, "position">; // Activity Bar Position 子菜单
  readonly menu: Menu<WorkbenchMenuContext, "views" | "activity" | "position" | "visibility" | "reset">; // Scoped workbench context-menu contributions.
  readonly extensions: ReadonlyMap<string, WorkbenchExtension>; // 响应式视图，成员由注册作用域管理
  readonly theme: Ref<"dark" | "light">;
  readonly sidebarLocation: Ref<"left" | "right">;
  readonly activityBarLocation: Ref<"default" | "top" | "bottom" | "hidden">; // 持久化活动栏位置，跨标签页同步
  use(extension: WorkbenchExtension): void; // 在当前 EffectScope 中注册扩展，随 Scope 自动卸载
  panels(): PanelDefinition[];
  open(panelId: string): void;
  toggle(panelId: string, requireActiveGroup?: boolean): void;
  toggleLeftSidebar(): void;
  setSidebarPosition(side: "left" | "right"): void;
  toggleSidebarPosition(): void;
  clearSavedGroups(): void;
  attach(api: DockviewApi): void;
}
```
