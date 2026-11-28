import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("keeps a durable catalog intact when a patch changes an item's ID", async () => {
  const modules = await createHarnessModules();
  const directory = mkdtempSync(join(tmpdir(), "harness-catalog-identity-"));
  vi.stubEnv("HARNESS_CHAT_DB", join(directory, "runtime.db"));
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, transport, catalogs, sqlite] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      modules.load<typeof import("../../packages/workspace-catalog/src/index.ts")>(
        "/packages/workspace-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    const original = { id: "first", name: "Original", folders: ["/tmp"], instructions: "" };
    const second = { ...original, id: "second", name: "Second" };
    const renamed = { ...original, name: "Renamed" };

    async function close(scope: ReturnType<typeof web.createServerScope>): Promise<void> {
      const db = scope.get(sqlite.SqliteService);
      scope.dispose();
      await db.close();
    }

    const scope = web.createServerScope();
    try {
      const catalog = scope.get(catalogs.WorkspaceCatalog);
      const server = serverCalls(scope.get(transport.ServerTransport));
      const route = "state-sync:workspaces.items";
      await server.handleCall(route, [], {
        opId: "create",
        ops: [original, second].map((item) => ({
          type: "insert",
          id: item.id,
          beforeId: null,
          item,
        })),
      });
      const before = catalog.host.snapshot();

      await expect(
        server.handleCall(route, [], {
          opId: "bad-update",
          ops: [{ type: "update", id: original.id, item: second }],
        }),
      ).rejects.toThrow("SyncedArray item ID does not match patch ID");
      await expect(
        server.handleCall(route, [], {
          opId: "bad-insert",
          ops: [{ type: "insert", id: "third", beforeId: null, item: second }],
        }),
      ).rejects.toThrow("SyncedArray item ID does not match patch ID");
      expect(catalog.host.snapshot()).toEqual(before);

      await server.handleCall(route, [], {
        opId: "rename",
        ops: [{ type: "update", id: renamed.id, item: renamed }],
      });
    } finally {
      await close(scope);
    }

    const reopened = web.createServerScope();
    try {
      expect(reopened.get(catalogs.WorkspaceCatalog).items).toEqual([renamed, second]);
    } finally {
      await close(reopened);
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
