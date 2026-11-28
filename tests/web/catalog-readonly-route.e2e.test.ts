import { expect, it, vi } from "vite-plus/test";
import type { StateSyncStreamMessage } from "../../packages/state-sync/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("a readonly catalog registration also owns its patch route", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, transport, sync, sqlite, catalogs, handlers] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
        "/packages/state-sync/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
      modules.load<typeof import("../../packages/workspace-catalog/src/index.ts")>(
        "/packages/workspace-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/ui-workspace/src/node.ts")>(
        "/packages/ui-workspace/src/node.ts",
      ),
    ]);
    const root = web.createServerScope();
    const database = root.get(sqlite.SqliteService);
    const catalog = root.get(catalogs.WorkspaceCatalog);
    const server = serverCalls(root.get(transport.ServerTransport));
    const stateSync = root.get(sync.StateSyncServerService);
    const patchRoute = "state-sync:workspaces.items";
    const insert = (id: string) =>
      server.handleCall(patchRoute, [], {
        opId: id,
        ops: [
          {
            type: "insert",
            id,
            beforeId: null,
            item: { id, name: id, folders: ["/tmp"], instructions: "" },
          },
        ],
      });
    const persistedIds = async () => {
      await database.flush();
      return database
        .read<{ id: string }>("SELECT id FROM workspaces ORDER BY position")
        .map(({ id }) => id);
    };
    const readonly = sync.defineStateSyncContract("workspaces", {
      items: sync.stateSync.array(catalogs.WorkspaceSchema, { readonly: true }),
    });
    const owner = root.createChild();
    let hostResolutions = 0;
    let reader: AsyncIterator<unknown> | undefined;
    try {
      await expect(insert("before")).resolves.toMatchObject({ opId: "before" });
      expect(await persistedIds()).toEqual(["before"]);
      owner.run(() =>
        stateSync.useHandlers(readonly, {
          items: () => {
            hostResolutions += 1;
            return catalog.host;
          },
        }),
      );
      reader = serverCalls(root.get(transport.ServerTransport))
        .handleStream("/stream/state-sync:workspaces.items", [], undefined)
        [Symbol.asyncIterator]();
      const snapshot = (await reader.next()).value as StateSyncStreamMessage;
      expect(snapshot).toMatchObject({
        type: "snapshot",
        snapshot: { items: [expect.objectContaining({ id: "before" })] },
      });

      await expect(insert("denied")).rejects.toThrow("State-sync path is read-only");
      expect(hostResolutions).toBe(1);
      expect(catalog.items.map(({ id }) => id)).toEqual(["before"]);
      expect(await persistedIds()).toEqual(["before"]);

      const pendingFrame = reader.next();
      owner.dispose();
      expect((await pendingFrame).done).toBe(true);
      await expect(insert("retired")).rejects.toThrow("Unknown call path");
      expect(await persistedIds()).toEqual(["before"]);

      root.run(handlers.useWorkspaceHandlers);
      await expect(insert("after")).resolves.toMatchObject({ opId: "after" });
      expect(await persistedIds()).toEqual(["before", "after"]);
    } finally {
      owner.dispose();
      await reader?.return?.();
      root.dispose();
      await database.close();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
