import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type TerminalModule = typeof import("../../packages/terminal/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let terminal: TerminalModule;
let spawnError: string | undefined;

const LONG_RUNNING = { shell: "/bin/sh", args: ["-c", "sleep 30"] };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, terminal] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<TerminalModule>("/packages/terminal/src/index.ts"),
  ]);
  const probe = new terminal.TerminalService();
  try {
    const info = await probe.create(LONG_RUNNING);
    if (!isAlive(info.pid)) spawnError = "spawned PTY exited immediately";
  } catch (error) {
    spawnError = `node-pty cannot spawn here: ${String(error)}`;
  } finally {
    probe.dispose();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await harness.close();
});

describe("TerminalService lifecycle", () => {
  it("kills its PTYs when the providing scope is disposed", async (context) => {
    if (spawnError !== undefined) context.skip(spawnError);
    const root = di.createRootScope({ id: "root" });
    root.provide(terminal.TerminalService);
    const service = root.get(terminal.TerminalService);
    const info = await service.create(LONG_RUNNING);
    expect(isAlive(info.pid)).toBe(true);

    root.dispose();

    expect(service.list()).toEqual([]);
    await vi.waitFor(() => expect(isAlive(info.pid)).toBe(false), { timeout: 5000 });
  });

  it("does not warn outside a scope and keeps PTYs until disposed explicitly", async (context) => {
    if (spawnError !== undefined) context.skip(spawnError);
    const warn = vi.spyOn(console, "warn");
    const service = new terminal.TerminalService();
    expect(warn).not.toHaveBeenCalled();

    const info = await service.create(LONG_RUNNING);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(info.pid)).toBe(true);
    expect(service.list().map((entry) => entry.id)).toEqual([info.id]);

    service.dispose();
    expect(service.list()).toEqual([]);
    await vi.waitFor(() => expect(isAlive(info.pid)).toBe(false), { timeout: 5000 });
  });
});
