import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import type {
  ArrayOp,
  ArraySnapshot,
  ArraySyncFrame,
  StateSyncStreamMessage,
} from "../../packages/state-sync/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

type CatalogMessage = StateSyncStreamMessage<ArraySnapshot, ArraySyncFrame>;

const catalogs = [
  {
    table: "workspaces",
    item: { id: "existing", name: "Existing", folders: ["/workspace"], instructions: "" },
  },
];

it.each(catalogs)(
  "acknowledges empty $table changes without rewriting persisted rows",
  async ({ table, item }) => {
    const modules = await createHarnessModules();
    const directory = mkdtempSync(join(tmpdir(), "harness-catalog-noop-"));
    const path = join(directory, "runtime.db");
    vi.stubEnv("HARNESS_CHAT_DB", path);
    vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    try {
      const [web, transport, sqlite] = await Promise.all([
        modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
          "/apps/web/src/server/scope.ts",
        ),
        modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
      ]);
      const root = web.createServerScope();
      const database = root.get(sqlite.SqliteService);
      const server = serverCalls(root.get(transport.ServerTransport));
      const streamServer = serverCalls(root.get(transport.ServerTransport));
      const patch = (opId: string, op: ArrayOp) =>
        server.handleCall(`state-sync:${table}.items`, [], { opId, ops: [op] });
      const persistedIds = async () => {
        await database.flush();
        return database.read<{ id: string }>(`SELECT id FROM ${table}`).map(({ id }) => id);
      };
      const deletions = () =>
        database.read<{ count: number }>("SELECT COUNT(*) AS count FROM catalog_deletions")[0];
      try {
        await patch("seed", { type: "insert", id: item.id, beforeId: null, item });
        expect(await persistedIds()).toEqual(["existing"]);
        const schema = new DatabaseSync(path);
        try {
          schema.exec(`
            CREATE TABLE catalog_deletions (id TEXT);
            CREATE TRIGGER track_catalog_deletions AFTER DELETE ON ${table}
            BEGIN
              INSERT INTO catalog_deletions VALUES (OLD.id);
            END
          `);
        } finally {
          schema.close();
        }

        const reader = (
          streamServer.handleStream(
            `/stream/state-sync:${table}.items`,
            [],
            undefined,
          ) as AsyncIterable<CatalogMessage>
        )[Symbol.asyncIterator]();
        try {
          const initialRevision = (await reader.next()).value.snapshot?.rev;
          const ack = { opId: "already-removed", ops: [], rev: initialRevision };
          await expect(
            patch("already-removed", { type: "remove", id: "missing" }),
          ).resolves.toEqual(ack);
          expect((await reader.next()).value.frame).toEqual(ack);
          expect(await persistedIds()).toEqual(["existing"]);
          expect(deletions()).toEqual({ count: 0 });

          const remove = { type: "remove", id: "existing" } as const;
          await expect(patch("remove-existing", remove)).resolves.toMatchObject({
            opId: "remove-existing",
            ops: [remove],
          });
          expect(await persistedIds()).toEqual([]);
          expect(deletions()).toEqual({ count: 1 });
        } finally {
          await reader.return?.();
        }
      } finally {
        root.dispose();
        await database.close();
      }
    } finally {
      vi.unstubAllEnvs();
      await modules.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
