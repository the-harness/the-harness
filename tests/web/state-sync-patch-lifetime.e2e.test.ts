import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("sends StateSync patches only while their client scope is active", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, di, gateway, sqlite, stateSync, transport, workspaces, zod] =
      await Promise.all([
        modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
          "/apps/web/src/server/scope.ts",
        ),
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/gateway/src/index.ts")>(
          "/packages/gateway/src/index.ts",
        ),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
        modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
          "/packages/state-sync/src/index.ts",
        ),
        modules.load<typeof import("../../packages/transport/src/index.ts")>(
          "/packages/transport/src/index.ts",
        ),
        modules.load<typeof import("../../packages/ui-workspace/src/contract.ts")>(
          "/packages/ui-workspace/src/contract.ts",
        ),
        modules.load<{ z: typeof import("zod").z }>(
          "/packages/state-sync/node_modules/zod/index.js",
        ),
      ]);
    const runtime = web.createServerScope();
    const database = runtime.get(sqlite.SqliteService);
    const root = di.createRootScope();
    const server = createServer();
    const upgradeStarted = Promise.withResolvers<void>();
    const approveUpgrade = Promise.withResolvers<void>();
    try {
      const contract = stateSync.defineStateSyncContract("scope-test", {
        record: stateSync.stateSync.record(zod.z.string()),
        value: stateSync.stateSync.value(zod.z.string()),
      });
      const record = runtime.run(() => new stateSync.SyncedRecordHost<string>());
      const value = runtime.run(() => new stateSync.SyncedValueHost("initial"));
      const valueWrites: unknown[] = [];
      value.subscribe((frame) => valueWrites.push(frame.value));
      runtime.run(() =>
        runtime.get(stateSync.StateSyncServerService).useHandlers(contract, {
          record: () => record,
          value: () => value,
        }),
      );
      gateway.attachGateway(server, async () => runtime.get(transport.ServerTransport) as never, {
        authenticators: [
          {
            async authenticate() {
              upgradeStarted.resolve();
              await approveUpgrade.promise;
              return { surfaceId: "catalog", role: "owner" };
            },
          },
        ],
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      vi.stubGlobal("location", {
        protocol: "http:",
        host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      root.provideAll([
        transport.WebTransportConnection,
        [transport.Transport, transport.WebTransport],
        stateSync.StateSyncClientService,
      ]);
      const sync = root.get(stateSync.StateSyncClientService);
      const useClients = () => ({
        catalog: sync.use(workspaces.WorkspaceStateSyncContract).items,
        ...sync.use(contract),
      });
      const workspace = (id: string) => ({ id, name: id, folders: ["/tmp"], instructions: "" });
      const firstScope = root.createChild();
      const first = firstScope.run(useClients);
      first.catalog.items.push(workspace("retired"));
      first.record.items.set("retired", "queued");
      first.value.value = "queued";
      await upgradeStarted.promise;
      firstScope.dispose();
      first.value.value = "written after disposal";

      const secondScope = root.createChild();
      const second = secondScope.run(useClients);
      second.record.items.set("active", "new");
      second.value.value = "new";
      second.catalog.items.push(workspace("active"));
      approveUpgrade.resolve();

      await expect.poll(() => second.catalog.pendingCount).toBe(0);
      await database.flush();
      const rows = database.read("SELECT id FROM workspaces");
      expect({ rows, record: [...record.items], valueWrites }).toEqual({
        rows: [{ id: "active" }],
        record: [["active", "new"]],
        valueWrites: ["new"],
      });
      await expect.poll(() => second.catalog.items.map((item) => item.id)).toEqual(["active"]);
    } finally {
      approveUpgrade.resolve();
      root.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.dispose();
      await database.close();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await modules.close();
  }
});
