import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type SessionManagerModule = typeof import("../../packages/session-manager/src/index.ts");
type SessionCatalogModule = typeof import("../../packages/session-catalog/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type ReactivityModule = typeof import("reactivity");

let harness: HarnessModules;
let di: DiModule;
let sessionManager: SessionManagerModule;
let sessionCatalog: SessionCatalogModule;
let sqlite: SqliteModule;
let reactivity: ReactivityModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, sessionManager, sessionCatalog, sqlite, reactivity] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<SessionManagerModule>("/packages/session-manager/src/index.ts"),
    harness.load<SessionCatalogModule>("/packages/session-catalog/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<ReactivityModule>("reactivity"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createManager() {
  const disposed: string[] = [];
  let setups = 0;
  class Probe {
    readonly id: string;
    constructor(id: string) {
      this.id = id;
      reactivity.onScopeDispose(() => disposed.push(id));
    }
  }
  const root = di.createRootScope();
  root.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    sessionCatalog.SessionCatalog,
    sessionManager.SessionManager,
  ]);
  const manager = root.get(sessionManager.SessionManager);
  root.run(() =>
    manager.useSessionSetup((id) => {
      setups += 1;
      di.useServices([di.createDescriptor(Probe, id)]);
      di.inject(Probe);
    }),
  );
  return { root, manager, disposed, setups: () => setups, Probe };
}

describe("session manager scopes", () => {
  it("creates a session scope once and runs the session setups with its id", () => {
    const { root, manager, setups, Probe } = createManager();
    try {
      const scope = manager.acquire("a");
      expect(scope.id).toBe("session:a");
      expect(scope.get(Probe).id).toBe("a");
      expect(manager.get("a")).toBe(scope);
      expect(manager.acquire("a")).toBe(scope);
      expect(setups()).toBe(1);
    } finally {
      root.dispose();
    }
  });

  it("releases a session scope exactly once and ignores unknown ids", () => {
    const { root, manager, disposed } = createManager();
    try {
      const scope = manager.acquire("b");
      manager.release("b");
      manager.release("b");
      manager.release("unknown");
      expect(scope.isDisposed).toBe(true);
      expect(manager.get("b")).toBeUndefined();
      expect(disposed).toEqual(["b"]);
    } finally {
      root.dispose();
    }
  });

  it("disposes every remaining session when the owning scope is disposed", () => {
    const { root, manager, disposed } = createManager();
    manager.acquire("e");
    manager.acquire("e2");
    root.dispose();
    expect(disposed.slice().sort()).toEqual(["e", "e2"]);
    expect(manager.get("e")).toBeUndefined();
  });
});
