import { createRootScope, CurrentScope } from "@harness/di";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { FileEditorService, FileEditorTabDescriptor } from "@harness/ui-editor";
import { UiConfigService } from "@harness/ui-config";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import {
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { createDockview } from "dockview-vue";
import { nextTick } from "vue";

export async function observeWindowTabs() {
  const scope = createRootScope();
  const container = document.createElement("div");
  container.style.cssText = "width:800px;height:500px";
  document.body.appendChild(container);
  const dock = createDockview(container, {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  dock.layout(800, 500);
  let tabs: UiTabsService, editor: FileEditorService;
  const resolver = {
    get<T>(id: abstract new (...args: any[]) => T): T {
      if (id === CurrentScope) return scope as T;
      if (id === UiStorageService) return { use: () => ({ positions: {} }) } as T;
      if (id === UiTabsService) return tabs as T;
      if (id === FileEditorService) return editor as T;
      if (id === UiConfigService)
        return { get: (_key: string, fallback: unknown) => fallback } as T;
      if (id === VscodeWorkspaceCompatService) return {} as T;
      if (id === UiWorkspaceService)
        return {
          onFileChange() {},
          getRoot: () => ({
            readFile: async () => ({
              content: "saved",
              size: 5,
              mtimeMs: 1,
              binary: false,
              tooLarge: false,
            }),
          }),
        } as T;
      throw new Error(`Unexpected fixture dependency: ${id.name}`);
    },
  };
  const compat = scope.run(() =>
    runInInjectionContext(resolver, () => {
      tabs = new UiTabsService();
      editor = new FileEditorService();
      tabs.attach(dock);
      return new VscodeWindowCompatService();
    }),
  );
  const flush = async () => {
    await Promise.resolve();
    await nextTick();
  };
  const events: number[][] = [];
  compat.tabGroups.onDidChangeTabs((event) =>
    events.push([event.opened.length, event.changed.length, event.closed.length]),
  );
  try {
    const source = await editor!.openDocument("/fixture", "first.ts", { preview: true });
    const first = tabs!.open(
      new FileEditorTabDescriptor({
        documentId: source.id,
        name: source.name,
      }),
    );
    await flush();
    const group = compat.tabGroups.activeTabGroup;
    const tab = group.activeTab!;
    const preview = tab.isPreview;
    editor!.updateContent("/fixture/first.ts", "changed");
    await flush();
    const dirty = tab.isDirty && !tab.isPreview;
    const originalGroupId = compat.tabGroupsSnapshot.value.groups[0]!.id;
    const otherGroupId = tabs!.splitGroup(originalGroupId, "right")!;
    tabs!.move(first.tabId, otherGroupId);
    await flush();
    const moved = compat.tabGroups.all.some(
      (candidate) => candidate.activeTab === tab && candidate !== group,
    );
    const cancelled = await compat.tabGroups.close(tab);
    await flush();
    const remained = tabs!.get(first.tabId) !== undefined && tab.isDirty;
    const accepted = await compat.tabGroups.close(tab);
    await flush();
    return {
      preview,
      dirty,
      moved,
      cancelled,
      remained,
      accepted,
      removed: !tabs!.get(first.tabId),
      path: (tab.input as { uri: { path: string } }).uri.path,
      events,
      state: compat.windowState.value,
    };
  } finally {
    dock.dispose();
    scope.dispose();
    container.remove();
  }
}
