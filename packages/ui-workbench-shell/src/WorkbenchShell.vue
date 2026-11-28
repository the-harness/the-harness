<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: WorkbenchLayout, ActivityBar, ContextMenu, Menu, Dialog, SidebarTitle, EditorTabs, StatusBar, Sash. Adaptation: Dockview supplies docking; Reka supplies sidebar menu focus and dismissal. Layout control order and state icons follow VS Code 1f8d8b21a2e98baccf533e6f453156b0a323ea84 layoutActions.ts. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  RovingFocusGroup,
  TooltipProvider,
} from "reka-ui";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { z } from "zod";
import {
  DockviewVue,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewWillDropEvent,
  type DockviewWillShowOverlayLocationEvent,
} from "dockview-vue";
import { ContextMenu, IconButton } from "@harness/ui-components-base";
import { useScope } from "@harness/ui-di";
import { ChatCoreExtension, ChatPanel, ChatTabDescriptor, openChatTab } from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { CommandPalette, UiCommandsService } from "@harness/ui-commands";
import { UiNotificationService } from "@harness/ui-notifications";
import { OutputPanel } from "@harness/ui-output";
import { QuickInputModal } from "@harness/ui-quick-input";
import { SessionsPanel, UiSessionsService } from "@harness/ui-sessions";
import { UiStatusBarService } from "@harness/ui-status-bar";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import { TerminalPanel, UiTerminalService } from "@harness/ui-terminal";
import {
  attachDockSashBehavior,
  ExtensionsPanel,
  NotesExtension,
  notesSettings,
  NotesPanel,
  PanelHost,
  PreviewPanel,
  SettingsPanel,
  StatusBarSlot,
  UiTabsService,
  UiWorkbenchService,
  WorkbenchTab,
  WorkbenchViewTitle,
  type WorkbenchAction,
  type WorkbenchMenuTarget,
  type TabMenuContext,
} from "@harness/ui-workbench";
import { FileEditorService, FileEditorTabDescriptor, FileEditorView } from "@harness/ui-editor";
import { FilePickerHost } from "@harness/ui-file-picker";
import {
  ChangesPanel,
  FilesPanel,
  openWorkspaceTab,
  UiWorkspaceService,
  WorkspacePanel,
  WorkspaceTabDescriptor,
} from "@harness/ui-workspace";

import WorkbenchActivityBar from "./WorkbenchActivityBar.vue";
import { useQuickAccess } from "./quickAccess.ts";
import { createResponsiveLayout } from "./responsiveLayout.ts";
import WorkbenchManageMenu from "./WorkbenchManageMenu.vue";
import WorkbenchStatusItem from "./WorkbenchStatusItem.vue";

const rootScope = useScope();

const workbench = rootScope.get(UiWorkbenchService);
const commandsService = rootScope.get(UiCommandsService);
const statusBar = rootScope.get(UiStatusBarService);
const chat = rootScope.get(UiChatManagerService);
const workspaceService = rootScope.get(UiWorkspaceService);
const sessions = rootScope.get(UiSessionsService);
const notifications = rootScope.get(UiNotificationService);
const terminal = rootScope.get(UiTerminalService);
const storage = rootScope.get(UiStorageService);

const notes = storage.use(...notesSettings, new CrossTabSync());
const theme = workbench.theme;
const sidebarLocation = workbench.sidebarLocation;
const activityBarLocation = workbench.activityBarLocation;
const toast = notifications.message;

const layoutKey = "harness.layout.v1";
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const shortcutKey = isMac ? "Meta" : "Control";
const shortcutModifier = isMac ? "⌘" : "Ctrl";
const shortcutLabel = isMac ? shortcutModifier : `${shortcutModifier}+`;
const palette = ref(false);
const settingsOpen = ref(false);
let settingsReturnFocus: HTMLElement | undefined;
let settingsMovingToEditor = false;
const activePanel = ref("chat");
const visiblePanels = ref(new Set<string>());
const viewRegions = computed(
  () =>
    new Map(
      workbench
        .panels()
        .flatMap(({ id, location, presentation }) =>
          presentation === "view"
            ? [[id, location === "within" ? "right" : location] as const]
            : [],
        ),
    ),
);
const visibleRegions = computed(
  () => new Set([...visiblePanels.value].map((id) => viewRegions.value.get(id))),
);
const dockTheme = { ...themeDark, name: "harness", className: "dockview-theme-harness" };
let dock: DockviewApi | undefined;
let responsive: ReturnType<typeof createResponsiveLayout> | undefined;
let lastEditorFocus: HTMLElement | undefined;
let draggingSource: { panelId?: string; groupId?: string } | null = null;
let disposables: { dispose(): void }[] = [];
const shellMenu = ref<InstanceType<typeof ContextMenu>>();
const shellMenuContext = shallowRef<WorkbenchMenuTarget>();
const statusVisibility = storage.use("core:ui-workbench:status-bar", {
  hidden: z.array(z.string()).default([]),
}, new CrossTabSync());
const leftStatusItems = computed(() => statusBar.leftItems.value.filter((item) => !statusVisibility.hidden.includes(item.id)));
const rightStatusItems = computed(() => statusBar.rightItems.value.filter((item) => !statusVisibility.hidden.includes(item.id)));
const shellMenuGroups = computed(() => {
  const context = shellMenuContext.value;
  if (!context) return [];
  const region = context.area === "view" ? viewRegions.value.get(context.panelId)
    : context.area === "activityBar" ? "left" : undefined;
  if (context.area === "view" && !region) return [];
  return workbench.menu.resolve({
    ...context, region,
    visibleRegions: visibleRegions.value,
    visiblePanels: visiblePanels.value,
    panels: workbench.panels().filter((panel) => viewRegions.value.get(panel.id) === region),
    statusItems: [
      ...statusBar.leftItems.value, ...statusBar.rightItems.value,
      { id: "core:model", name: "Model", text: "" },
      { id: "core:run-status", name: "Generation Status", text: "" },
    ],
    hiddenStatusItems: statusVisibility.hidden,
    sidebarShortcut: `${shortcutLabel}B`,
    toggleRegion: (region) => { if (region === "left") togglePrimarySidebar(); else toggleViewRegion(region); },
    togglePanel: async (id) => {
      const restore = !!region && regionContainsFocus(region);
      if (visiblePanels.value.has(id)) tabs.close(id);
      else workbench.open(id);
      await nextTick();
      if (restore && document.activeElement === document.body) focusEditor();
    },
    toggleStatusItem: async (id) => {
      statusVisibility.hidden = statusVisibility.hidden.includes(id)
        ? statusVisibility.hidden.filter((hidden) => hidden !== id) : [...statusVisibility.hidden, id];
      await nextTick();
      if (document.activeElement === document.body) document.querySelector<HTMLElement>("footer.statusbar")?.focus();
    },
    setActivityBarPosition,
    resetLayout,
  });
});
const shellMenuLabel = computed(() => {
  const context = shellMenuContext.value;
  if (context?.area === "titlebar") return "Title Bar actions";
  if (context?.area === "statusbar") return "Status Bar actions";
  if (context?.area === "view" && viewRegions.value.get(context.panelId) !== "left") return "View actions";
  return "Primary Side Bar actions";
});
const layoutControls = computed(() => {
  const primaryVisible = visibleRegions.value.has("left");
  const secondaryVisible = visibleRegions.value.has("right");
  const bottomVisible = visibleRegions.value.has("below");
  const primary = {
    id: "primary",
    label: "Toggle primary sidebar",
    title: `Toggle primary sidebar (${shortcutLabel}B)`,
    shortcut: `${shortcutKey}+B`,
    active: primaryVisible,
    icon:
      sidebarLocation.value === "left"
        ? primaryVisible
          ? "i-codicon-layout-sidebar-left"
          : "i-codicon-layout-sidebar-left-off"
        : primaryVisible
          ? "i-codicon-layout-sidebar-right"
          : "i-codicon-layout-sidebar-right-off",
    run: togglePrimarySidebar,
  };
  const bottom = {
    id: "bottom",
    label: "Toggle bottom panel",
    title: "Toggle bottom panel (" + shortcutLabel + "`)",
    shortcut: shortcutKey + "+`",
    active: bottomVisible,
    icon: bottomVisible ? "i-codicon-layout-panel" : "i-codicon-layout-panel-off",
    run: () => toggleViewRegion("below"),
  };
  const secondary = {
    id: "secondary",
    label: "Toggle workspace panel",
    title: "Toggle workspace panel",
    shortcut: undefined,
    active: secondaryVisible,
    icon:
      sidebarLocation.value === "left"
        ? secondaryVisible
          ? "i-codicon-layout-sidebar-right"
          : "i-codicon-layout-sidebar-right-off"
        : secondaryVisible
          ? "i-codicon-layout-sidebar-left"
          : "i-codicon-layout-sidebar-left-off",
    run: () => toggleViewRegion("right"),
  };
  return sidebarLocation.value === "left"
    ? [primary, bottom, secondary]
    : [secondary, bottom, primary];
});

function openSettings(anchor = document.activeElement) {
  if (settingsOpen.value) return;
  settingsMovingToEditor = false;
  settingsReturnFocus = anchor instanceof HTMLElement ? anchor : undefined;
  settingsOpen.value = true;
}

function openSettingsFromMenu() {
  openSettings(document.querySelector(".manage-button"));
}

function focusSettings(event: Event) {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  const input = event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]');
  (input ?? event.currentTarget).focus();
}

function openSettingsInEditor() {
  settingsMovingToEditor = true;
  workbench.open("settings");
}

async function restoreSettingsFocus(event: Event) {
  const target = settingsReturnFocus?.isConnected
    ? settingsReturnFocus
    : document.querySelector<HTMLElement>(".manage-button");
  settingsReturnFocus = undefined;
  if (settingsMovingToEditor) {
    settingsMovingToEditor = false;
    event.preventDefault();
    await nextTick();
    const search = dock
      ?.getPanel("settings")
      ?.group.element.querySelector<HTMLInputElement>(
        '.settings-panel input[aria-label="Search settings"]',
      );
    (search ?? target)?.focus();
    return;
  }
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

const coreCommands: WorkbenchAction[] = [
  {
    id: "new-conversation",
    title: "New conversation",
    icon: "i-codicon-add",
    shortcut: `${shortcutModifier} N`,
    run: newConversation,
  },
  {
    id: "show-conversations",
    title: "Show Conversations",
    icon: "i-codicon-comment-discussion",
    run: () => workbench.open("sessions"),
  },
  {
    id: "show-files",
    title: "Show Files",
    icon: "i-codicon-files",
    run: () => workbench.open("files"),
  },
  {
    id: "open-settings",
    title: "Open Settings",
    icon: "i-codicon-settings-gear",
    shortcut: `${shortcutModifier} ,`,
    run: openSettings,
  },
  {
    id: "toggle-primary-sidebar",
    title: "Layout: Toggle primary sidebar",
    icon: "i-codicon-layout-sidebar-left",
    shortcut: `${shortcutModifier} B`,
    run: togglePrimarySidebar,
  },
  {
    id: "move-primary-sidebar",
    title: "Layout: Move primary sidebar",
    icon: "i-codicon-layout-sidebar-right",
    run: () => workbench.toggleSidebarPosition(),
  },
  {
    id: "toggle-bottom-panel",
    title: "Layout: Toggle Terminal",
    icon: "i-codicon-layout-panel",
    shortcut: shortcutModifier + " `",
    run: () => toggleViewRegion("below"),
  },
  {
    id: "toggle-secondary-sidebar",
    title: "Layout: Toggle workspace panel",
    icon: "i-codicon-layout-sidebar-right",
    run: () => toggleViewRegion("right"),
  },
];
const commands = computed<WorkbenchAction[]>(() => [
  ...coreCommands,
  ...[...workbench.extensions.values()].flatMap((extension) => extension.commands ?? []),
  ...commandsService.commands.value.flatMap(({ id, meta }) =>
    meta?.title
      ? [
          {
            id,
            title: meta.category ? `${meta.category}: ${meta.title}` : meta.title,
            icon: meta.icon ?? "i-codicon-symbol-event",
            run: () => void commandsService.execute(id),
          },
        ]
      : [],
  ),
]);

const settingsActions = {
  onReset: () => resetLayout(),
  onSidebarSide: (side: "left" | "right") => workbench.setSidebarPosition(side),
};
const settingsComponent = () => h(SettingsPanel, settingsActions);

workbench.use({
  id: "harness.settings",
  panels: [
    {
      id: "settings",
      title: "Settings",
      icon: "i-codicon-settings-gear",
      component: settingsComponent,
      location: "within",
      presentation: "editor",
    },
  ],
});

const tabs = rootScope.get(UiTabsService);
const files = rootScope.get(FileEditorService);
let lastEditorPanel = "";
const quickAccess = useQuickAccess(
  palette, commands, files, tabs, workspaceService, workbench, () => lastEditorPanel,
);
const paletteQuery = quickAccess.query;
tabs.useRenderer({
  descriptor: ChatTabDescriptor,
  component: ChatPanel,
  icon: "i-codicon-chat-sparkle",
  location: "within",
});
tabs.useRenderer({
  descriptor: WorkspaceTabDescriptor,
  component: WorkspacePanel,
  icon: "i-codicon-folder-library",
  location: "within",
  titleActions: [
    {
      id: "workspace-new-session",
      title: "New conversation in workspace",
      icon: "i-codicon-add",
      run: () => {
        const ws = workspaceService.currentWorkspace.value;
        openChatTab(tabs, sessions, chat, { id: sessions.newSession(ws?.id) });
        focusChatComposer();
      },
    },
    {
      id: "workspace-duplicate",
      title: "Duplicate workspace",
      icon: "i-codicon-copy",
      run: () => {
        const ws = workspaceService.currentWorkspace.value;
        if (!ws) return;
        const copy = workspaceService.duplicateWorkspace(ws.id);
        if (copy) openWorkspaceTab(tabs, workspaceService, copy);
      },
    },
  ],
});

tabs.useRenderer({
  descriptor: FileEditorTabDescriptor,
  component: FileEditorView,
  icon: (descriptor) => {
    const path = files.getDocumentById(descriptor.documentId)?.path;
    return (path && workbench.getFileIconClass(path)) || "i-codicon-file-code";
  },
  location: "within",
});

function syncDockState() {
  if (!dock) return;
  const visible = new Set<string>();
  for (const group of dock.groups) {
    const isVisible = group.api.isVisible;
    group.element.inert = !isVisible;
    group.element.ariaHidden = isVisible ? null : "true";
    if (!isVisible) continue;
    for (const panel of group.panels) visible.add(panel.id);
  }
  visiblePanels.value = visible;
  activePanel.value = dock.activePanel?.id ?? "";
  if (!viewRegions.value.has(activePanel.value)) lastEditorPanel = activePanel.value;
}

function rememberEditorFocus(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".dv-content-container")) return;
  const group = dock?.groups.find((group) => group.element.contains(target));
  if (group?.activePanel && !viewRegions.value.has(group.activePanel.id)) lastEditorFocus = target;
}

function focusEditor() {
  const groups =
    dock?.groups.filter(
      (group) =>
        group.api.isVisible && group.activePanel && !viewRegions.value.has(group.activePanel.id),
    ) ?? [];
  const visible = (element: HTMLElement) =>
    element.isConnected && element.getClientRects().length > 0 && !element.closest("[inert]");
  const previous = lastEditorFocus && visible(lastEditorFocus) ? lastEditorFocus : undefined;
  const group = groups.find((group) => previous && group.element.contains(previous)) ?? groups[0];
  if (!group) return;
  const content = group.element.querySelector<HTMLElement>(".dv-content-container");
  const input = [
    ...(content?.querySelectorAll<HTMLElement>(
      'textarea, input:not([type="hidden"]), [contenteditable="true"]',
    ) ?? []),
  ].find(visible);
  group.activePanel?.api.setActive();
  (previous ?? input ?? content)?.focus();
}

function regionContainsFocus(region: "left" | "right" | "below", target = document.activeElement) {
  return Boolean(
    target &&
    dock?.groups.some(
      (group) =>
        group.element.contains(target) &&
        group.panels.some((panel) => viewRegions.value.get(panel.id) === region),
    ),
  );
}

function togglePrimarySidebar() {
  const restore = regionContainsFocus("left");
  workbench.toggleLeftSidebar();
  if (restore) void nextTick(focusEditor);
}

function toggleViewRegion(region: "right" | "below") {
  if (!dock) return;
  const groups = dock.groups.filter((group) =>
    group.panels.some((panel) => viewRegions.value.get(panel.id) === region),
  );
  if (groups.length === 0) {
    if (region === "right") {
      workbench.open("files");
      workbench.open("changes");
      workbench.open("files");
    } else {
      workbench.open("terminal");
    }
    return;
  }
  const show = !visibleRegions.value.has(region);
  const restore = !show && regionContainsFocus(region);
  for (const group of groups) group.api.setVisible(show);
  syncDockState();
  if (restore) void nextTick(focusEditor);
}

function focusChatComposer() {
  void nextTick(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      '.dv-active-group .chat-panel textarea[aria-label="Message Harness"]',
    );
    if (input?.getClientRects().length && !input.closest("[inert]")) input.focus();
  });
}

function newConversation() {
  sessions.newSession(workspaceService.currentWorkspace.value?.id);
  workbench.open("chat");
  focusChatComposer();
}

function resetLayout(showMessage = true) {
  if (!dock) return;
  const reconnect = Boolean(responsive);
  responsive?.dispose();
  responsive = undefined;
  workbench.clearSavedGroups();
  dock.clear();
  workbench.open("chat");
  const primaryDirection = sidebarLocation.value === "right" ? "right" : "left";
  const auxiliaryDirection = primaryDirection === "left" ? "right" : "left";
  dock.addPanel({
    id: "files",
    title: "Files",
    component: "extension",
    params: { panelId: "files" },
    position: { direction: auxiliaryDirection },
    initialWidth: 290,
    minimumWidth: 210,
  });
  dock.addPanel({
    id: "changes",
    title: "Changes",
    component: "extension",
    params: { panelId: "changes" },
    position: { referencePanel: "files", direction: "within" },
    inactive: true,
  });
  dock.addPanel({
    id: "sessions",
    title: "Conversations",
    component: "extension",
    params: { panelId: "sessions" },
    position: { direction: primaryDirection },
    initialWidth: 250,
    minimumWidth: 200,
  });
  dock.getPanel("files")?.api.setActive();
  dock.getPanel("sessions")?.api.setSize({ width: 250 });
  dock.getPanel("files")?.api.setSize({ width: 290 });
  dock.getPanel("chat")?.api.setActive();
  syncDockState();
  if (reconnect) attachResponsiveLayout();
  if (showMessage) notifications.notify("Default layout restored");
}

const saveLayout = useDebounceFn(() => {
  if (!dock) return;
  try {
    localStorage.setItem(layoutKey, JSON.stringify(responsive?.serialize() ?? dock.toJSON()));
  } catch {
    notifications.notify("Layout could not be saved in this browser");
  }
}, 250);

function attachResponsiveLayout(saved?: Parameters<typeof createResponsiveLayout>[5]) {
  if (!dock || !dockContainer.value) return;
  responsive?.dispose();
  responsive = createResponsiveLayout(
    dock,
    dockContainer.value,
    (id) => viewRegions.value.get(id),
    () => { syncDockState(); saveLayout(); },
    (group) => void nextTick(() => {
      if (!group) return focusEditor();
      const target = group.element.querySelector<HTMLElement>(
        '[role="tree"], input, textarea, button, [tabindex="0"]',
      );
      target?.focus();
    }),
    saved,
  );
}

function onReady(event: DockviewReadyEvent) {
  dock = event.api;
  workbench.attach(dock);
  const saved = localStorage.getItem(layoutKey) ?? localStorage.getItem("harness.layout.compact.v1");
  let restored: Parameters<typeof createResponsiveLayout>[5];
  if (saved) {
    try {
      const layout = JSON.parse(saved);
      const known = new Set(workbench.panels().map((panel) => panel.id));
      if (Object.keys(layout.panels).some((id) => !known.has(id))) throw new Error("Unknown panel");
      dock.fromJSON(layout);
      restored = layout;
      const viewRegion = (id: string) => {
        const location = workbench.panels().find((view) => view.id === id)?.location;
        return location === "within" ? "right" : location;
      };
      for (const definition of workbench
        .panels()
        .filter((panel) => panel.presentation === "view")) {
        const panel = dock.getPanel(definition.id);
        if (
          panel &&
          panel.group.panels.length > 1 &&
          (definition.location === "left" ||
            panel.group.panels.some(
              (item) =>
                workbench.panels().find((view) => view.id === item.id)?.presentation !== "view" ||
                viewRegion(item.id) !== viewRegion(definition.id),
            ))
        ) {
          if (
            definition.location === "left" &&
            panel.group.panels.every((item) => viewRegion(item.id) === "right")
          ) {
            panel.api.close();
            continue;
          }
          panel.api.moveTo({
            group: panel.group,
            position:
              definition.location === "below"
                ? "bottom"
                : definition.location === "right"
                  ? sidebarLocation.value === "right"
                    ? "left"
                    : "right"
                  : sidebarLocation.value,
          });
        }
      }
      const leftViews = dock.panels.filter((panel) => viewRegion(panel.id) === "left");
      if (leftViews.length > 1) {
        const keep = leftViews.find((panel) => panel.id === activePanel.value) ?? leftViews[0]!;
        for (const panel of leftViews) {
          if (panel.id !== keep.id) panel.api.close();
        }
      }
      if (!dock.panels.length) resetLayout(false);
    } catch {
      resetLayout(false);
    }
  } else resetLayout(false);
  attachResponsiveLayout(restored);
  syncDockState();
  disposables = [
    dock.onDidLayoutChange(() => {
      syncDockState();
      saveLayout();
    }),
    dock.onWillShowOverlay(keepViewsSeparate),
    dock.onWillDrop(keepViewsSeparate),
    dock.onWillDragPanel((event) => {
      draggingSource = { panelId: event.panel.id, groupId: event.panel.group?.id };
    }),
    dock.onWillDragGroup((event) => {
      draggingSource = { groupId: event.group.id };
    }),
    dock.onDidActivePanelChange(({ panel }) => {
      const descriptor = panel && tabs.get(panel.id)?.descriptor;
      const activeSession =
        descriptor instanceof ChatTabDescriptor
          ? sessions.sessions.value.find(({ id }) => id === descriptor.sessionId)
          : panel?.id === "chat"
            ? sessions.current.value
            : undefined;
      const workspaceId =
        descriptor instanceof WorkspaceTabDescriptor
          ? descriptor.workspaceId
          : activeSession?.workspaceId;
      if (workspaceId) workspaceService.activeWorkspaceId.value = workspaceId;
      syncDockState();
    }),
  ];
}

function keepViewsSeparate(event: DockviewWillDropEvent | DockviewWillShowOverlayLocationEvent) {
  const rawTransfer = event.getData();
  const transfer = rawTransfer?.panelId || rawTransfer?.groupId ? rawTransfer : draggingSource;
  if (!transfer) return;
  const sourceGroup = transfer.panelId
    ? dock?.getPanel(transfer.panelId)?.group
    : transfer.groupId
      ? dock?.getGroup(transfer.groupId)
      : undefined;
  if (
    transfer.panelId &&
    sourceGroup &&
    sourceGroup.panels.length <= 1 &&
    (!event.group || event.group.id === sourceGroup.id)
  ) {
    event.preventDefault();
    return;
  }
  if (
    !transfer.panelId &&
    transfer.groupId &&
    (!event.group || event.group.id === transfer.groupId)
  ) {
    event.preventDefault();
    return;
  }
  if (event.position !== "center") return;
  const source = transfer.panelId
    ? [transfer.panelId]
    : (dock?.getGroup(transfer.groupId)?.panels.map((panel) => panel.id) ?? []);
  const target = event.group?.panels.map((panel) => panel.id) ?? [];
  const definitions = workbench.panels();
  const isView = (id: string) =>
    definitions.find((panel) => panel.id === id)?.presentation === "view";
  const viewRegion = (id: string) => {
    const location = definitions.find((panel) => panel.id === id)?.location;
    return location === "within" ? "right" : location;
  };
  const standalone = definitions.some(
    (panel) =>
      panel.presentation === "view" &&
      panel.location === "left" &&
      [...source, ...target].includes(panel.id),
  );
  if (standalone || source.some(isView) !== target.some(isView)) {
    event.preventDefault();
    return;
  }
  if (source.some(isView)) {
    const regions = new Set([...source, ...target].map(viewRegion).filter(Boolean));
    if (regions.size > 1) event.preventDefault();
  }
}

async function setActivityBarPosition(value: typeof activityBarLocation.value) {
  if (activityBarLocation.value === value) return;
  activityBarLocation.value = value;
  await nextTick();
  const target =
    [...document.querySelectorAll<HTMLElement>(".activity-bar button")].find(
      (element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
    ) ?? document.querySelector<HTMLElement>(".manage-button");
  target?.focus();
}

function isMenuEvent(event: MouseEvent | KeyboardEvent) {
  return !event.defaultPrevented && (!(event instanceof KeyboardEvent) ||
    (!event.isComposing && event.keyCode !== 229 &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))));
}

async function openShellMenu(context: WorkbenchMenuTarget, event: MouseEvent | KeyboardEvent) {
  if (!isMenuEvent(event) || !(event.target instanceof HTMLElement)) return;
  shellMenuContext.value = context;
  if (!shellMenuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const anchor = event instanceof MouseEvent ? event : event.target;
  await nextTick();
  shellMenu.value?.show(anchor);
}

function openSidebarContextMenu(event: MouseEvent | KeyboardEvent) {
  void openShellMenu({ area: "activityBar" }, event);
}

const tabContext = shallowRef<TabMenuContext>();
const tabMenu = ref<InstanceType<typeof ContextMenu>>();
const tabMenuGroups = computed(() => {
  const context = tabContext.value;
  void tabs.groups.value;
  if (!context || !dock?.getPanel(context.tabId)) return [];
  return tabs.menu.resolve(context);
});

async function onDockContextMenu(event: MouseEvent | KeyboardEvent) {
  if (!isMenuEvent(event)) return;
  const target = event.target as HTMLElement | null;
  const header = target?.closest(".dv-tabs-and-actions-container");
  if (!header) return;
  const tabElement = target?.closest<HTMLElement>(".dv-tab");
  const group = dock?.groups.find((group) => group.element.contains(header));
  const tabId = tabElement?.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? group?.activePanel?.id;
  const viewId = tabId && viewRegions.value.has(tabId)
    ? tabId
    : header.querySelector<HTMLElement>("[data-view-id]")?.dataset.viewId;
  if (viewId) {
    await openShellMenu({ area: "view", panelId: viewId }, event);
    return;
  }
  if (!tabId) return;
  const anchor = tabElement ?? header.querySelector<HTMLElement>('.dv-tab[aria-selected="true"]');
  if (!anchor) return;
  tabContext.value = { tabId, afterClose: () => {
    void nextTick(() => { if (document.activeElement === document.body) focusEditor(); });
  } };
  if (!tabMenuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  await nextTick();
  tabMenu.value?.show(event instanceof MouseEvent ? event : anchor, anchor);
}

useEventListener(window, "dragend", () => {
  draggingSource = null;
});

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.isComposing || event.altKey) return;
  const key = event.key.toLowerCase();
  const primary = isMac ? event.metaKey : event.ctrlKey;
  let prefix: string | undefined;
  if (primary && key === "p") prefix = event.shiftKey ? ">" : "";
  else if (primary && event.shiftKey && key === "o") prefix = "@";
  else if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === "g") prefix = ":";
  if (prefix === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  quickAccess.show(prefix);
}, { capture: true });

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  const inPopup = event.target instanceof Element &&
    event.target.closest('[role="menu"], [role="dialog"], [role="listbox"], [role="combobox"]');
  if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented &&
    !inPopup && !palette.value && !settingsOpen.value && responsive?.dismiss()) {
    event.preventDefault();
    return;
  }
  if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    quickAccess.show(">");
    return;
  }
  if (event.key === ",") {
    event.preventDefault();
    openSettings();
    return;
  }
  const editable =
    event.target instanceof HTMLElement &&
    (event.target.matches("input, textarea, select") || event.target.isContentEditable);
  if (event.key.toLowerCase() === "n" && !editable) {
    event.preventDefault();
    newConversation();
  }
  if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    togglePrimarySidebar();
  }
  if (event.key === "`") {
    event.preventDefault();
    toggleViewRegion("below");
  }
});

watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value;
  },
  { immediate: true },
);

const dockContainer = ref<HTMLElement>();
watch(activityBarLocation, async () => {
  await nextTick();
  responsive?.refresh();
});
let disposeSash: (() => void) | undefined;
onMounted(() => {
  if (dockContainer.value) disposeSash = attachDockSashBehavior(dockContainer.value);
});
onBeforeUnmount(() => {
  responsive?.dispose();
  disposeSash?.();
  disposables.forEach((disposable) => disposable.dispose());
});
</script>

<template>
  <div class="app-shell">
    <ChatCoreExtension />
    <NotesExtension v-if="notes.enabled" />
    <header class="titlebar" @contextmenu="openShellMenu({ area: 'titlebar' }, $event)"
      @keydown="openShellMenu({ area: 'titlebar' }, $event)">
      <div class="brand">
        <span class="brand-mark" role="img" aria-label="THE HARNESS" />
      </div>
      <button
        type="button"
        class="command-center"
        aria-label="Open command palette"
        :aria-keyshortcuts="`${shortcutKey}+K`"
        @click="quickAccess.show('>')"
      >
        <span class="i-codicon-search" aria-hidden="true" />
        <span class="command-center-label">Search commands</span>
        <kbd aria-hidden="true">{{ shortcutLabel }}K</kbd>
      </button>
      <div class="titlebar-tools">
        <div class="titlebar-actions" role="group" aria-label="Layout controls">
          <IconButton
            v-for="control in layoutControls"
            :key="control.id"
            :icon="control.icon"
            :label="control.label"
            :title="control.title"
            :aria-keyshortcuts="control.shortcut"
            :aria-pressed="control.active"
            :active="control.active"
            :class="{ 'secondary-sidebar-toggle': control.id === 'secondary' }"
            @click="control.run()"
          />
        </div>
        <RovingFocusGroup v-if="activityBarLocation !== 'default'" class="titlebar-manage">
          <WorkbenchManageMenu
            side="bottom"
            :shortcut-label="shortcutLabel"
            @settings="openSettingsFromMenu"
            @commands="quickAccess.show('>')"
          />
        </RovingFocusGroup>
      </div>
    </header>
    <div class="workbench-body" :class="{ 'sidebar-right': sidebarLocation === 'right' }">
      <WorkbenchActivityBar
        v-if="activityBarLocation === 'default'"
        position="default"
        :side="sidebarLocation"
        :expanded="visiblePanels.has('sessions')"
        @activate="workbench.toggle('sessions')"
        @contextmenu="openSidebarContextMenu"
        @keydown="openSidebarContextMenu"
      >
        <span class="spacer" />
        <WorkbenchManageMenu
          :side="sidebarLocation === 'left' ? 'right' : 'left'"
          :shortcut-label="shortcutLabel"
          @settings="openSettingsFromMenu"
          @commands="quickAccess.show('>')"
        />
      </WorkbenchActivityBar>
      <main
        ref="dockContainer"
        class="dock-container"
        @contextmenu.capture="onDockContextMenu"
        @keydown.capture="onDockContextMenu"
        @focusin="rememberEditorFocus"
      >
        <DockviewVue
          class="dockview"
          :theme="dockTheme"
          :disable-floating-groups="true"
          :disable-auto-resizing="true"
          @ready="onReady"
          ><template #prefixHeaderActions="params"
            ><WorkbenchViewTitle :params="params" side="prefix">
              <template #activityBar>
                <WorkbenchActivityBar
                  v-if="activityBarLocation === 'top'"
                  position="top"
                  :side="sidebarLocation"
                  :expanded="visiblePanels.has('sessions')"
                  @activate="workbench.open('sessions')"
                  @contextmenu="openSidebarContextMenu"
                  @keydown="openSidebarContextMenu"
                />
              </template> </WorkbenchViewTitle></template
          ><template #rightHeaderActions="params"
            ><WorkbenchViewTitle :params="params" side="right" /></template
          ><template #defaultTab="params"><WorkbenchTab :params="params" /></template
          ><template #panel-extension="params">
            <div class="workbench-panel-host">
              <div class="workbench-panel-content"><PanelHost :params="params" /></div>
              <WorkbenchActivityBar
                v-if="
                  activityBarLocation === 'bottom' &&
                  viewRegions.get(params.params.panelId) === 'left'
                "
                position="bottom"
                :side="sidebarLocation"
                :expanded="visiblePanels.has('sessions')"
                @activate="workbench.open('sessions')"
                @contextmenu="openSidebarContextMenu"
                @keydown="openSidebarContextMenu"
              />
            </div> </template
          ><template #watermark
            ><div class="watermark">
              <span class="i-codicon-sparkle" />
              <h2>A place to build.</h2>
              <button class="primary-button" @click="workbench.open('chat')">Open chat</button
              ><button class="text-button mt-2" @click="resetLayout()">Restore workspace</button>
            </div></template
          ></DockviewVue
        >
      </main>
    </div>
    <TooltipProvider :delay-duration="400">
      <footer class="statusbar" tabindex="-1" aria-label="Status Bar"
        @contextmenu="openShellMenu({ area: 'statusbar' }, $event)"
        @keydown="openShellMenu({ area: 'statusbar' }, $event)">
        <WorkbenchStatusItem
          v-for="item in leftStatusItems"
          :key="item.id"
          :item="item"
          :dark="workbench.theme.value === 'dark'"
          @activate="(command) => commandsService.execute(command)"
        />
        <StatusBarSlot />
        <span class="spacer" />
        <WorkbenchStatusItem
          v-for="item in rightStatusItems"
          :key="item.id"
          :item="item"
          :dark="workbench.theme.value === 'dark'"
          @activate="(command) => commandsService.execute(command)"
        />
        <span v-if="chat.isRunning() && !statusVisibility.hidden.includes('core:run-status')" class="status-state"
          ><span class="i-codicon-loading animate-spin" />Generating</span
        >
        <span v-if="chat.selectedModel.value && !statusVisibility.hidden.includes('core:model')" class="preview-status">{{
          chat.selectedModel.value.name
        }}</span>
      </footer>
    </TooltipProvider>
    <CommandPalette
      v-model="palette"
      v-model:query="paletteQuery"
      :commands="quickAccess.items.value"
      :search="quickAccess.search.value"
      :label="quickAccess.label.value"
      :placeholder="quickAccess.placeholder.value"
      :empty-text="quickAccess.emptyText.value"
      :loading="quickAccess.loading.value"
      :hint="quickAccess.hint.value"
      @accept="quickAccess.accept"
    />
    <DialogRoot v-model:open="settingsOpen">
      <DialogPortal>
        <DialogOverlay class="dialog-overlay settings-backdrop" />
        <DialogContent
          class="settings-dialog"
          @open-auto-focus="focusSettings"
          @close-auto-focus="restoreSettingsFocus"
        >
          <header class="settings-dialog-titlebar">
            <DialogTitle class="settings-dialog-title">Settings</DialogTitle>
            <div class="settings-dialog-actions">
              <DialogClose as-child>
                <IconButton
                  icon="i-codicon-open-preview"
                  label="Open Settings in Editor"
                  @click="openSettingsInEditor"
                />
              </DialogClose>
              <DialogClose as-child>
                <IconButton icon="i-codicon-close" label="Close Settings" />
              </DialogClose>
            </div>
          </header>
          <DialogDescription class="sr-only"
            >Harness appearance, conversation and layout preferences.</DialogDescription
          >
          <SettingsPanel v-bind="settingsActions" in-dialog />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <QuickInputModal />
    <FilePickerHost />
    <ContextMenu ref="tabMenu" label="Editor tab actions" :groups="tabMenuGroups" />
    <ContextMenu ref="shellMenu" :label="shellMenuLabel" :groups="shellMenuGroups" />
    <Transition name="toast">
      <ContextMenu v-if="toast" label="Notification actions" :groups="notifications.menu.resolve({ message: toast })">
      <div class="toast-message" role="status">
        <span class="i-codicon-info text-[var(--accent)]" />{{ toast
        }}<IconButton
          icon="i-codicon-close"
          label="Dismiss notification"
          @click="notifications.dismiss()"
        /></div>
      </ContextMenu>
    </Transition>
  </div>
</template>

<style scoped>
.command-center,
.titlebar-actions :deep(.icon-button) {
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.command-center-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand {
  display: grid;
  place-items: center;
  flex: 0 0 48px;
  height: 100%;
}

.brand-mark {
  width: 24px;
  height: 18px;
  transform: translateX(-2px);
  display: block;
  flex-shrink: 0;
  background: var(--strong);
  mask: url("./brand-mark.svg") center / contain no-repeat;
}

@media (max-width: 600px) {
  .brand {
    flex-basis: 40px;
  }
}

.settings-backdrop {
  background: var(--shadow);
}

.settings-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 1501;
  display: flex;
  flex-direction: column;
  width: min(1280px, 86vw);
  height: min(780px, 78dvh);
  max-height: calc(100dvh - 32px);
  transform: translate(-50%, -50%);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--raised);
  box-shadow: 0 12px 40px var(--shadow);
}

.settings-dialog:focus {
  outline: none;
}

.settings-dialog-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 34px;
  padding: 4px 8px 4px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.settings-dialog-title {
  margin: 0;
  color: var(--strong);
  font-size: 13px;
  font-weight: 600;
}

.settings-dialog-actions {
  display: flex;
  gap: 2px;
}

@media (max-width: 640px) {
  .settings-dialog {
    width: calc(100vw - 24px);
    height: calc(100dvh - 32px);
  }
}
</style>
