import { createRootScope, CurrentScope } from "@harness/di";
import { FileEditorService, FileEditorTabDescriptor } from "@harness/ui-editor";
import { UiConfigService } from "@harness/ui-config";
import { UiStorageService } from "@harness/ui-storage";
import {
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { UiTabsService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { createDockview } from "dockview-vue";
import { defineComponent, ref } from "vue";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";
import { createMainThreadWorkspace } from "../../../packages/vscode-ext-host/src/main-thread/workspace.ts";

const names = ["first # draft.ts", "blocked.ts", "split.ts", "hidden.ts", "clean.ts", "other.ts"];

async function mount(root: string, otherRoot: string) {
  const scope = createRootScope();
  scope.provideAll([UiConfigService, UiStorageService]);
  const config = scope.get(UiConfigService);
  const activeRoots = ref([root]);
  const saved: Record<string, string> = Object.fromEntries(names.map((name) => [name, "initial"]));
  const writes: string[] = [];
  let blocked = true;
  const workspaceSource = {
    activeRoots,
    onFileChange: () => () => {},
    getRoot: () => ({
      async readFile(name: string) {
        const text = saved[name];
        if (text === undefined) throw new Error(`Missing fixture file: ${name}`);
        return {
          content: text,
          size: text.length,
          encoding: "utf8",
          mtimeMs: 1,
          binary: false,
          tooLarge: false,
        };
      },
      async writeFile(name: string, text: string) {
        writes.push(name);
        if (blocked && name === "blocked.ts") throw new Error("File has been modified on disk");
        saved[name] = text;
        return { mtimeMs: 2, size: text.length };
      },
    }),
  };
  const container = document.createElement("div");
  container.style.cssText = "width:800px;height:500px";
  document.body.append(container);
  const dock = createDockview(container, {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  let tabs: UiTabsService;
  let files: FileEditorService;
  let workspace: VscodeWorkspaceCompatService;
  const windowCompat = scope.run(() =>
    runInInjectionContext(
      {
        get<T>(id: abstract new (...args: any[]) => T): T {
          if (id === CurrentScope) return scope as T;
          if (id === UiWorkspaceService) return workspaceSource as T;
          if (id === UiTabsService) return tabs as T;
          if (id === FileEditorService) return files as T;
          if (id === VscodeWorkspaceCompatService) return workspace as T;
          if (id === UiConfigService) return config as T;
          if (id === UiStorageService) return scope.get(UiStorageService) as T;
          throw new Error(`Unexpected fixture dependency: ${id.name}`);
        },
      },
      () => {
        tabs = new UiTabsService();
        files = new FileEditorService();
        workspace = new VscodeWorkspaceCompatService();
        tabs.useRenderer({
          descriptor: FileEditorTabDescriptor,
          component: defineComponent(() => () => null),
        });
        tabs.attach(dock);
        return new VscodeWindowCompatService();
      },
    ),
  );
  dock.layout(800, 500);
  const dispose = () => {
    dock.dispose();
    scope.dispose();
    container.remove();
  };
  try {
    for (const name of names) {
      const file = await files!.openDocument(name === "other.ts" ? otherRoot : root, name);
      if (name !== "clean.ts") files!.updateContent(file.path, `changed ${name}`);
      if (name === "hidden.ts") continue;
      const descriptor = new FileEditorTabDescriptor({ documentId: file.id, name });
      const tab = tabs!.open(descriptor);
      if (name === "split.ts") {
        const group = dock.getPanel(tab.tabId)!.group.id;
        const otherGroup = tabs!.splitGroup(group, "right")!;
        tabs!.open(descriptor, { groupId: otherGroup, reuseExisting: false });
      }
    }
    const dispatch = createMainThreadWorkspace(
      {
        activeRoots,
        getRoot: workspaceSource.getRoot as never,
        saveFileEditor: (uri) => windowCompat.saveFileEditor(uri),
        saveAllFileEditors: () => windowCompat.saveAllFileEditors(),
      },
      config,
      workspace!,
    );
    return {
      dispatch,
      snapshot: () => ({
        saved,
        writes,
        dirty: [...files!.documents.values()]
          .filter((file) => files!.isDirty(file))
          .map(({ name }) => name),
      }),
      unblock() {
        blocked = false;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

let fixture: Awaited<ReturnType<typeof mount>>;
export async function setup(root: string, otherRoot: string): Promise<void> {
  fixture = await mount(root, otherRoot);
}

export function dispatch(method: string, args: unknown[]) {
  return fixture.dispatch(method, args);
}

export function snapshot() {
  return fixture.snapshot();
}

export function unblock() {
  fixture.unblock();
}

export function dispose() {
  fixture?.dispose();
}
