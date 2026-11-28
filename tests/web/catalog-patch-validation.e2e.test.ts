import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("rejects invalid catalog values before publishing or storing them", async () => {
  const modules = await createHarnessModules();
  const directory = mkdtempSync(join(tmpdir(), "harness-catalog-validation-"));
  vi.stubEnv("HARNESS_CHAT_DB", join(directory, "catalogs.db"));
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, transport, sessions, workspaces, sqlite] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      modules.load<typeof import("../../packages/session-catalog/src/index.ts")>(
        "/packages/session-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/workspace-catalog/src/index.ts")>(
        "/packages/workspace-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    const workspace = { id: "work", name: "Workspace", folders: [directory], instructions: "" };
    const meta = { workspaceRoots: [directory] };

    async function close(scope: ReturnType<typeof web.createServerScope>): Promise<void> {
      const database = scope.get(sqlite.SqliteService);
      scope.dispose();
      await database.close();
    }

    const writer = web.createServerScope();
    try {
      const server = serverCalls(writer.get(transport.ServerTransport));
      const route = "state-sync:workspaces.items";
      const host = writer.get(workspaces.WorkspaceCatalog).host;
      await server.handleCall(route, [], {
        opId: "insert",
        ops: [{ type: "insert", id: workspace.id, beforeId: null, item: workspace }],
      });
      const before = host.snapshot();
      await expect(
        server.handleCall(route, [], {
          opId: "invalid-update",
          ops: [{ type: "update", id: workspace.id, item: { ...workspace, folders: directory } }],
        }),
      ).rejects.toThrow();
      expect(host.snapshot()).toEqual(before);

      // Sessions only change through the catalog's own calls, which validate their input.
      const catalog = writer.get(sessions.SessionCatalog);
      await server.handleCall("sessions.create", [], { id: "session", workspaceId: workspace.id });
      await server.handleCall("sessions.setMeta", [], { id: "session", meta });
      const created = catalog.host.snapshot();
      await expect(
        server.handleCall("sessions.rename", [], { id: "session", title: null }),
      ).rejects.toThrow();
      await expect(
        server.handleCall("state-sync:sessions.items", [], {
          opId: "write",
          ops: [{ type: "remove", id: "session" }],
        }),
      ).rejects.toThrow("State-sync path is read-only");
      expect(catalog.host.snapshot()).toEqual(created);
    } finally {
      await close(writer);
    }

    const reader = web.createServerScope();
    try {
      expect(reader.get(workspaces.WorkspaceCatalog).items).toEqual([workspace]);
      expect(reader.get(sessions.SessionCatalog).items).toEqual([
        { id: "session", workspaceId: workspace.id, createdAt: expect.any(Number), meta },
      ]);
    } finally {
      await close(reader);
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
