import { mkdtempSync, realpathSync, rmSync, utimesSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type WorkspaceNodeModule = typeof import("../../packages/ui-workspace/src/node.ts");
type WorkspaceWatchEvent = import("../../packages/ui-workspace/src/rpc.ts").WorkspaceWatchEvent;

let harness: HarnessModules;
let di: DiModule;
let workspace: WorkspaceNodeModule;
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, workspace] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<WorkspaceNodeModule>("/packages/ui-workspace/src/node.ts"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  await harness.close();
});

function makeDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-workspace-fs-")));
  tempDirs.push(dir);
  return dir;
}

function twoServices() {
  const scopes = [di.createRootScope({ id: "a" }), di.createRootScope({ id: "b" })];
  for (const scope of scopes) scope.provide(workspace.WorkspaceFsService);
  const [a, b] = scopes.map((scope) => scope.get(workspace.WorkspaceFsService));
  return { a: a!, b: b!, dispose: () => scopes.forEach((scope) => scope.dispose()) };
}

function collector() {
  const events: WorkspaceWatchEvent[] = [];
  return {
    events,
    listener: (event: WorkspaceWatchEvent) => void events.push(event),
    saw: (name: string) => events.some((event) => event.relativePath === name),
  };
}

// FSEvents may drop changes made right after a watcher starts, so keep touching the file.
async function touchUntil(path: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; !done(); attempt++) {
    if (attempt >= 50) throw new Error(`no watch event for ${path}`);
    writeFileSync(path, String(attempt));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("WorkspaceFsService module state", () => {
  it("keeps a separate gitignore cache per service instance", async () => {
    const dir = makeDir();
    const gitignore = join(dir, ".gitignore");
    // A fixed mtime keeps the rewritten .gitignore indistinguishable to a cache keyed on mtime.
    const mtime = 1_700_000_000;
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "b.txt"), "");
    writeFileSync(gitignore, "a.txt\n");
    utimesSync(gitignore, mtime, mtime);
    const { a, b, dispose } = twoServices();

    const names = async (service: typeof a) =>
      (await service.readDir(dir)).entries.map((entry) => entry.name).sort();

    expect(await names(a)).toEqual([".gitignore", "b.txt"]);
    writeFileSync(gitignore, "b.txt\n");
    utimesSync(gitignore, mtime, mtime);

    expect(await names(a)).toEqual([".gitignore", "b.txt"]);
    expect(await names(b)).toEqual([".gitignore", "a.txt"]);
    dispose();
  });

  it("keeps separate watchers per service and closes one when its last subscriber leaves", async () => {
    const dir = makeDir();
    const closed: FSWatcher[] = [];
    const probe = watch(dir);
    const prototype = Object.getPrototypeOf(probe) as FSWatcher;
    probe.close();
    const close = prototype.close;
    vi.spyOn(prototype, "close").mockImplementation(function (this: FSWatcher) {
      closed.push(this);
      return close.call(this);
    });
    const { a, b, dispose } = twoServices();
    const a1 = collector();
    const a2 = collector();
    const b1 = collector();
    const unsubscribeA1 = a.subscribeRoots([dir], a1.listener);
    const unsubscribeA2 = a.subscribeRoots([dir], a2.listener);
    const unsubscribeB1 = b.subscribeRoots([dir], b1.listener);

    await touchUntil(
      join(dir, "first.txt"),
      () => a1.saw("first.txt") && a2.saw("first.txt") && b1.saw("first.txt"),
    );

    unsubscribeA1();
    expect(closed).toHaveLength(0);
    unsubscribeA2();
    expect(closed).toHaveLength(1);

    await touchUntil(join(dir, "second.txt"), () => b1.saw("second.txt"));
    expect(a1.saw("second.txt") || a2.saw("second.txt")).toBe(false);

    const a3 = collector();
    const unsubscribeA3 = a.subscribeRoots([dir], a3.listener);
    await touchUntil(join(dir, "third.txt"), () => a3.saw("third.txt"));

    unsubscribeA3();
    unsubscribeB1();
    expect(closed).toHaveLength(3);
    expect(new Set(closed).size).toBe(3);
    dispose();
  }, 30_000);
});
