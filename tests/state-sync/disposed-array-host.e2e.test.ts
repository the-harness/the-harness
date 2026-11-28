import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("rejects a write resolving to a retired StateSync array host", async () => {
  const modules = await createHarnessModules();
  try {
    const [di, rpc, stream, sync, { z }] = await Promise.all([
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/rpc/src/index.ts")>("/packages/rpc/src/index.ts"),
      modules.load<typeof import("../../packages/stream/src/index.ts")>(
        "/packages/stream/src/index.ts",
      ),
      modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
        "/packages/state-sync/src/index.ts",
      ),
      modules.load<{ z: typeof import("zod").z }>("/packages/state-sync/node_modules/zod/index.js"),
    ]);
    const server = di.createRootScope();
    try {
      server.provideAll([
        rpc.RpcServerService,
        stream.StreamServerService,
        sync.StateSyncServerService,
      ]);
      const contract = sync.defineStateSyncContract("retired", {
        items: sync.stateSync.array(z.object({ id: z.string() })),
      });
      const retired = server.createChild();
      const oldHost = retired.run(() => new sync.SyncedArrayHost([{ id: "old" }]));
      let host = oldHost;
      server.run(() => {
        server.get(sync.StateSyncServerService).useHandlers(contract, { items: () => host });
      });
      const call = server.get(rpc.RpcServerService);
      const patch = {
        opId: "append",
        ops: [{ type: "insert", id: "new", beforeId: null, item: { id: "new" } }],
      };

      await expect(
        call.handleCall("state-sync:retired.items", [], { opId: "empty", ops: [] }),
      ).resolves.toEqual({ rev: 0, opId: "empty", ops: [] });
      retired.dispose();
      await expect(call.handleCall("state-sync:retired.items", [], patch)).rejects.toThrow(
        "SyncedArrayHost is disposed",
      );
      expect(oldHost.items).toEqual([{ id: "old" }]);

      host = server.run(() => new sync.SyncedArrayHost([{ id: "replacement" }]));
      await expect(call.handleCall("state-sync:retired.items", [], patch)).resolves.toMatchObject({
        rev: 1,
        opId: "append",
      });
      expect(host.items).toEqual([{ id: "replacement" }, { id: "new" }]);
    } finally {
      server.dispose();
    }
  } finally {
    await modules.close();
  }
});
