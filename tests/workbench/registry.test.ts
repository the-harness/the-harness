import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { WorkbenchExtension } from "../../packages/ui-workbench/src/workbench.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type StorageModule = typeof import("../../packages/ui-storage/src/index.ts");
type TabsModule = typeof import("../../packages/ui-workbench/src/tabs.ts");
type WorkbenchModule = typeof import("../../packages/ui-workbench/src/workbench.ts");
type VueModule = typeof import("../../apps/web/src/reactivity.ts");
type Workbench = InstanceType<WorkbenchModule["UiWorkbenchService"]>;
type Dockview = Parameters<Workbench["attach"]>[0];

let harness: HarnessModules;
let di: DiModule;
let storage: StorageModule;
let tabs: TabsModule;
let workbenchModule: WorkbenchModule;
let vue: VueModule;
let root: ReturnType<DiModule["createRootScope"]>;
let owner: ReturnType<VueModule["effectScope"]>;
let workbench: Workbench;

interface FakePanel {
  id: string;
  api: {
    setActive(): void;
    close(): void;
  };
}

function fakeDock(initial: string[] = [], width = 1440) {
  const panels: FakePanel[] = [];
  const added: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const activated: string[] = [];
  const byId = new Map<string, FakePanel>();
  const add = (id: string): FakePanel => {
    const panel: FakePanel = {
      id,
      api: {
        setActive: () => activated.push(id),
        close: () => closed.push(id),
      },
    };
    panels.push(panel);
    byId.set(id, panel);
    return panel;
  };
  for (const id of initial) add(id);
  const listen = () => ({ dispose() {} });
  const dock = {
    width,
    groups: [],
    panels,
    getPanel: (id: string) => byId.get(id),
    addPanel: (options: Record<string, unknown>) => {
      added.push(options);
      return add(String(options.id));
    },
    onDidLayoutChange: listen,
    onDidActivePanelChange: listen,
    onDidActiveGroupChange: listen,
    onDidAddPanel: listen,
    onDidAddGroup: listen,
    onDidRemoveGroup: listen,
    onDidPanelPinnedChange: listen,
    onDidMovePanel: listen,
    onDidRemovePanel: listen,
  };
  return { dock: dock as unknown as Dockview, added, closed, activated };
}

const extension = (id: string, panels: WorkbenchExtension["panels"] = []): WorkbenchExtension => ({
  id,
  panels,
});

function register(contribution: WorkbenchExtension): () => void {
  const registration = owner.run(() => vue.effectScope())!;
  registration.run(() => workbench.use(contribution));
  return () => registration.stop();
}

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, storage, tabs, workbenchModule, vue] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<StorageModule>("/packages/ui-storage/src/index.ts"),
    harness.load<TabsModule>("/packages/ui-workbench/src/tabs.ts"),
    harness.load<WorkbenchModule>("/packages/ui-workbench/src/workbench.ts"),
    harness.load<VueModule>("/apps/web/src/reactivity.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  root = di.createRootScope();
  // The SSR test graph resolves DI reactivity and Vue separately.
  owner = vue.effectScope();
  workbench = owner.run(() => {
    root.provideAll([
      storage.UiStorageService,
      tabs.UiTabsService,
      workbenchModule.UiWorkbenchService,
    ]);
    return root.get(workbenchModule.UiWorkbenchService);
  })!;
});

afterEach(() => {
  vi.unstubAllGlobals();
  owner.stop();
  root.dispose();
});

describe("workbench extension registry", () => {
  it("registers extensions and flattens their panel contributions", () => {
    const first = register(
      extension("core", [
        {
          id: "chat",
          title: "Chat",
          icon: "chat",
          component: {} as never,
          location: "within",
        },
      ]),
    );
    const second = register({
      id: "commands",
      commands: [{ id: "run", title: "Run", icon: "run", run: () => {} }],
    });

    expect(workbench.extensions.size).toBe(2);
    expect(workbench.panels().map((panel) => panel.id)).toEqual(["chat"]);

    first();
    expect(workbench.extensions.size).toBe(1);
    expect(workbench.extensions.has("core")).toBe(false);
    expect(workbench.panels()).toEqual([]);

    second();
    expect(workbench.extensions.size).toBe(0);
  });

  it("ignores open calls before attach and for unknown panels", () => {
    register(extension("core"));
    expect(() => workbench.open("missing")).not.toThrow();

    const { dock, added } = fakeDock(["chat"]);
    owner.run(() => workbench.attach(dock));
    workbench.open("missing");
    expect(added).toEqual([]);
  });

  it("activates an existing panel instead of adding a duplicate", () => {
    register(
      extension("core", [
        {
          id: "chat",
          title: "Chat",
          icon: "chat",
          component: {} as never,
          location: "within",
        },
      ]),
    );
    const { dock, added, activated } = fakeDock(["chat"]);
    owner.run(() => workbench.attach(dock));

    workbench.open("chat");

    expect(added).toEqual([]);
    expect(activated).toEqual(["chat"]);
  });

  it("opens editor panels next to the chat and groups matching right-hand views", () => {
    register(
      extension("core", [
        {
          id: "chat",
          title: "Chat",
          icon: "chat",
          component: {} as never,
          location: "within",
        },
        {
          id: "explorer",
          title: "Explorer",
          icon: "files",
          component: {} as never,
          location: "right",
          presentation: "view",
        },
        {
          id: "context",
          title: "Context",
          icon: "context",
          component: {} as never,
          location: "right",
          presentation: "view",
        },
        {
          id: "notes",
          title: "Notes",
          icon: "notes",
          component: {} as never,
          location: "right",
        },
        {
          id: "sessions",
          title: "Conversations",
          icon: "sessions",
          component: {} as never,
          location: "left",
          presentation: "view",
        },
      ]),
    );
    const { dock, added } = fakeDock(["chat"]);
    owner.run(() => workbench.attach(dock));

    workbench.open("explorer");
    expect(added[0]).toMatchObject({
      id: "explorer",
      title: "Explorer",
      component: "extension",
      params: { panelId: "explorer" },
      position: { direction: "right" },
      initialWidth: 310,
      minimumWidth: 180,
      minimumHeight: 90,
    });

    workbench.open("context");
    expect(added[1]).toMatchObject({
      id: "context",
      position: { referencePanel: "explorer", direction: "within" },
    });

    workbench.open("notes");
    expect(added[2]).toMatchObject({
      id: "notes",
      position: { referencePanel: "chat", direction: "right" },
    });

    workbench.open("sessions");
    expect(added[3]).toMatchObject({
      id: "sessions",
      position: { direction: "left" },
      initialWidth: 250,
    });
  });

  it("mounts new editor panels inside the active editor on a narrow viewport", () => {
    register(
      extension("core", [
        {
          id: "chat",
          title: "Chat",
          icon: "chat",
          component: {} as never,
          location: "within",
        },
        {
          id: "preview",
          title: "Preview",
          icon: "preview",
          component: {} as never,
          location: "right",
        },
      ]),
    );
    const { dock, added } = fakeDock(["chat"], 600);
    owner.run(() => workbench.attach(dock));

    workbench.open("preview");

    expect(added[0]).toMatchObject({
      position: { referencePanel: "chat", direction: "within" },
    });
  });

  it("closes contributed panels when an extension is unregistered", () => {
    const registration = register(
      extension("workspace.notes", [
        {
          id: "notes",
          title: "Notes",
          icon: "notes",
          component: {} as never,
          location: "right",
        },
      ]),
    );
    const { dock, closed } = fakeDock(["notes"]);
    owner.run(() => workbench.attach(dock));

    registration();

    expect(closed).toEqual(["notes"]);
    expect(workbench.extensions.has("workspace.notes")).toBe(false);
  });

  it("keeps a replacement registered under the same id when the old registration is disposed", () => {
    const panel = (id: string) => [
      {
        id,
        title: id,
        icon: id,
        component: {} as never,
        location: "right" as const,
      },
    ];
    const original = register(extension("workspace", panel("original")));
    register(extension("workspace", panel("replacement")));

    original();

    expect(workbench.extensions.has("workspace")).toBe(true);
    expect(workbench.panels().map((entry) => entry.id)).toEqual(["replacement"]);
  });
});
