import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it.each(["rethrows", "reports"] as const)(
  "releases SQLite and preserves the catalog when the Web setup watcher %s an error",
  async (watcherBehavior) => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(join(artifacts, "web-failed-startup-"));
    const path = join(directory, "workspace.db");
    const modules = await createHarnessModules();
    vi.stubEnv("HARNESS_CHAT_DB", path);
    vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("DEEPSEEK_BASE_URL", undefined);

    try {
      const [web, rpc, di] = await Promise.all([
        modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
          "/apps/web/src/server/scope.ts",
        ),
        modules.load<typeof import("../../packages/rpc/src/index.ts")>(
          "/packages/rpc/src/index.ts",
        ),
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      ]);
      const seed = new DatabaseSync(path);
      try {
        seed.exec(`
          CREATE TABLE workspaces (
            position INTEGER NOT NULL,
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            folders TEXT NOT NULL,
            instructions TEXT NOT NULL
          );
          INSERT INTO workspaces VALUES (0, 'legacy', 'Legacy workspace', '["/legacy"]', '');
        `);
      } finally {
        seed.close();
      }

      const startupError = new Error("Web route registration failed");
      const registration = vi.spyOn(rpc.RpcServerService.prototype, "useHandlers");
      registration.mockImplementationOnce(() => {
        throw startupError;
      });
      const setup = di.Scope.prototype.setup;
      const setupWatcher = vi.spyOn(di.Scope.prototype, "setup");
      if (watcherBehavior === "reports") {
        setupWatcher.mockImplementation(function (this: InstanceType<typeof di.Scope>, fn) {
          if (this.id !== "web-server") return setup.call(this, fn);
          try {
            setup.call(this, fn);
          } catch (error) {
            if (error !== startupError) throw error;
          }
        });
      }
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const openedDatabase = () => exec.mock.contexts[0] as DatabaseSync | undefined;
      try {
        expect(() => web.createServerScope()).toThrow(startupError);
        expect(exec.mock.calls[0]?.[0]).toContain("PRAGMA journal_mode = WAL");
        const opened = openedDatabase();
        expect(opened).toBeDefined();
        await vi.waitFor(() => expect(opened?.isOpen).toBe(false));
      } finally {
        const opened = openedDatabase();
        registration.mockRestore();
        setupWatcher.mockRestore();
        exec.mockRestore();
        if (opened?.isOpen) opened.close();
      }

      const reader = new DatabaseSync(path, { readOnly: true });
      try {
        expect(reader.prepare("SELECT folders FROM workspaces WHERE id = 'legacy'").get()).toEqual({
          folders: '["/legacy"]',
        });
      } finally {
        reader.close();
      }
    } finally {
      vi.unstubAllEnvs();
      await modules.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
