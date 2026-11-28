import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type StorageModule = typeof import("../../packages/ui-storage/src/index.ts");
type TabsModule = typeof import("../../packages/ui-workbench/src/tabs.ts");
type ReactivityModule = typeof import("../../apps/web/src/reactivity.ts");
type ChatTabModule = typeof import("../../packages/ui-chat/src/tabs/ChatTab.ts");
type WorkspaceTabModule = typeof import("../../packages/ui-workspace/src/tabs/WorkspaceTab.ts");

let harness: HarnessModules;
let di: DiModule;
let storage: StorageModule;
let tabs: TabsModule;
let vue: ReactivityModule;
let chatTab: ChatTabModule;
let workspaceTab: WorkspaceTabModule;

const reactivityEntry = resolve(process.cwd(), "apps/web/src/reactivity.ts");
const tabsEntry = resolve(process.cwd(), "packages/ui-workbench/src/tabs.ts");

beforeAll(async () => {
  // UiTabsService uses vue; the DI scopes must share its reactivity, as in apps/web.
  harness = await createHarnessModules({
    aliases: [
      { find: /^reactivity$/, replacement: reactivityEntry },
      // The tab helpers only need the tab service; the package entry pulls in .vue files.
      { find: /^@harness\/ui-workbench$/, replacement: tabsEntry },
    ],
  });
  [di, storage, tabs, vue, chatTab, workspaceTab] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<StorageModule>("/packages/ui-storage/src/index.ts"),
    harness.load<TabsModule>("/packages/ui-workbench/src/tabs.ts"),
    harness.load<ReactivityModule>("reactivity"),
    harness.load<ChatTabModule>("/packages/ui-chat/src/tabs/ChatTab.ts"),
    harness.load<WorkspaceTabModule>("/packages/ui-workspace/src/tabs/WorkspaceTab.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function setup() {
  class TestTab extends tabs.TabDescriptor {
    constructor(readonly id: string) {
      super();
    }
    get key(): string {
      return `test:${this.id}`;
    }
    get defaultTitle(): string {
      return this.id;
    }
  }
  const root = di.createRootScope({ id: "root" });
  root.provideAll([storage.UiStorageService, tabs.UiTabsService]);
  return { root, service: root.get(tabs.UiTabsService), TestTab };
}

describe("UiTabsService.runOnce", () => {
  it("runs once per tab and key, in the tab's scope", () => {
    const { root, service, TestTab } = setup();
    const a = service.open(new TestTab("a"));
    const b = service.open(new TestTab("b"));
    const calls: string[] = [];
    const record = (label: string) => () => {
      calls.push(`${label}:${di.inject(tabs.TabContext).descriptor.key}`);
    };

    service.runOnce(a, "bind", record("bind"));
    service.runOnce(a, "bind", record("bind"));
    service.runOnce(a, "other", record("other"));
    service.runOnce(b, "bind", record("bind"));
    service.runOnce(b, "bind", record("bind"));

    expect(calls).toEqual(["bind:test:a", "other:test:a", "bind:test:b"]);
    root.dispose();
  });

  it("disposes effects created in the callback with the tab", () => {
    const { root, service, TestTab } = setup();
    const source = vue.ref(0);
    let effectRuns = 0;
    let disposed = false;
    const tab = service.open(new TestTab("a"));
    service.runOnce(tab, "bind", () => {
      vue.watchSyncEffect(() => {
        void source.value;
        effectRuns++;
      });
      vue.onScopeDispose(() => {
        disposed = true;
      });
    });
    source.value++;
    expect(effectRuns).toBe(2);

    service.close(tab.tabId);
    expect(disposed).toBe(true);
    expect(tab.scope.isDisposed).toBe(true);
    source.value++;
    expect(effectRuns).toBe(2);
    root.dispose();
  });

  it("retries a key whose callback threw and stops the failed attempt's effects", () => {
    const { root, service, TestTab } = setup();
    const tab = service.open(new TestTab("a"));
    const source = vue.ref(0);
    let effectRuns = 0;
    expect(() =>
      service.runOnce(tab, "bind", () => {
        vue.watchSyncEffect(() => {
          void source.value;
          effectRuns++;
        });
        throw new Error("bind failed");
      }),
    ).toThrow("bind failed");
    source.value++;
    expect(effectRuns).toBe(1);

    let runs = 0;
    service.runOnce(tab, "bind", () => void runs++);
    service.runOnce(tab, "bind", () => void runs++);
    expect(runs).toBe(1);
    root.dispose();
  });
});

describe("tab open helpers", () => {
  it("bind a chat tab that was created by a plain open", () => {
    const { root, service } = setup();
    const linked: unknown[] = [];
    const sessions = vue.shallowRef([{ id: "s1", title: "Renamed chat" }]);
    const rootSessions = { sessions, current: vue.shallowRef(undefined) };
    const chatManager = { link: (scope: unknown, id: string) => linked.push([scope, id]) };
    const plain = service.open(chatTab.ChatTabDescriptor.create({ sessionId: "s1" }));
    expect(plain.title).toBe("Chat");

    const open = () =>
      chatTab.openChatTab(service, rootSessions as never, chatManager as never, { id: "s1" });
    open();
    open();
    expect(service.tabs.size).toBe(1);
    expect(linked).toEqual([[plain.scope, "s1"]]);
    expect(plain.title).toBe("Renamed chat");
    root.dispose();
  });

  it("bind a workspace tab that was created by a plain open", () => {
    const { root, service } = setup();
    const name = vue.ref("Renamed workspace");
    const workspaceService = {
      activeWorkspaceId: vue.ref<string | undefined>(undefined),
      getWorkspace: (id: string) => (id === "w1" ? { id, name: name.value } : undefined),
    };
    const plain = service.open(workspaceTab.WorkspaceTabDescriptor.create({ workspaceId: "w1" }));
    expect(plain.title).toBe("Workspace");

    workspaceTab.openWorkspaceTab(service, workspaceService as never, { id: "w1" });
    expect(service.tabs.size).toBe(1);
    expect(plain.title).toBe("Renamed workspace");
    name.value = "Later name";
    return vue.nextTick().then(() => {
      expect(plain.title).toBe("Later name");
      root.dispose();
    });
  });
});
