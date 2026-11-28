export {
  AppearanceSettingsSlot,
  ChatComposerSlot,
  ChatInputNotificationSlot,
  ChatHeaderSlot,
  defineUiSlot,
  SettingsSlot,
  StatusBarSlot,
  ViewProgressSlot,
  type HookAnchor,
  type HookPosition,
  type UiSlot,
  type UiSlotComponent,
  type UiSlotContribute,
  type UiSlotContributeProps,
  type UiSlotNext,
} from "./slots.ts";
export {
  TabContext,
  TabDescriptor,
  UiTabsService,
  type OpenTabOptions,
  type TabDirection,
  type TabInstance,
  type TabGroupSnapshot,
  type TabPosition,
  type TabMenuContext,
  type TabRenderer,
} from "./tabs.ts";
export {
  createWorkbench,
  UiWorkbenchService,
  type PanelDefinition,
  type WorkbenchAction,
  type WorkbenchExtension,
  type WorkbenchMenuContext,
  type WorkbenchMenuTarget,
  type CodeMenuContext,
} from "./workbench.ts";

export { default as WorkbenchTab } from "./components/WorkbenchTab.vue";
export { default as WorkbenchViewTitle } from "./components/WorkbenchViewTitle.vue";
export { default as PanelHost } from "./panels/PanelHost.vue";
export { default as SettingsPanel } from "./panels/SettingsPanel.vue";
export { default as ExtensionsPanel } from "./panels/ExtensionsPanel.vue";
export { default as PreviewPanel } from "./panels/PreviewPanel.vue";
export { default as NotesPanel } from "./panels/NotesPanel.vue";
export { default as NotesExtension, notesSettings } from "./workbench/NotesExtension.vue";
export { attachDockSashBehavior } from "./workbench/sash.ts";
