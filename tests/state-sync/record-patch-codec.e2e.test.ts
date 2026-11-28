import { expect, it } from "vite-plus/test";
import type {
  RecordSnapshot,
  RecordSyncFrame,
  StateSyncStreamMessage,
} from "../../packages/state-sync/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";

type RecordMessage = StateSyncStreamMessage<RecordSnapshot, RecordSyncFrame>;

it("rejects a record patch before its codec failure can change or broadcast any entries", async () => {
  const modules = await createHarnessModules();
  try {
    const [di, rpc, stream, sync, zod] = await Promise.all([
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/rpc/src/index.ts")>("/packages/rpc/src/index.ts"),
      modules.load<typeof import("../../packages/stream/src/index.ts")>(
        "/packages/stream/src/index.ts",
      ),
      modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
        "/packages/state-sync/src/index.ts",
      ),
      modules.load<typeof import("zod")>("/packages/state-sync/node_modules/zod/index.js"),
    ]);
    const root = di.createRootScope();
    root.provideAll([
      rpc.RpcServerService,
      stream.StreamServerService,
      sync.StateSyncServerService,
    ]);
    const schema = zod.z.string();
    const initial = { preserved: "keep", renewed: "original" };
    const host = root.run(
      () =>
        new sync.SyncedRecordHost(Object.entries(initial), {
          deserialize: (raw) => schema.parse(raw),
        }),
    );
    const contract = sync.defineStateSyncContract("record-codec", {
      items: sync.stateSync.record(schema),
    });
    root.run(() =>
      root.get(sync.StateSyncServerService).useHandlers(contract, { items: () => host }),
    );
    const server = root.get(rpc.RpcServerService);
    const patch = (input: unknown) => server.handleCall("state-sync:record-codec.items", [], input);
    const reader = (
      root
        .get(stream.StreamServerService)
        .handleStream(
          "/stream/state-sync:record-codec.items",
          [],
          undefined,
        ) as AsyncIterable<RecordMessage>
    )[Symbol.asyncIterator]();
    try {
      expect((await reader.next()).value.snapshot).toEqual({ entries: initial });
      await expect(
        patch({ delete: ["preserved"], set: { partial: "decoded", invalid: 123 } }),
      ).rejects.toThrow("expected string");
      const rejectedItems = Object.fromEntries(host.items);
      const rejectedSnapshot = host.snapshot();

      await patch({ delete: ["renewed"], set: { renewed: "replacement" } });
      const frames = [(await reader.next()).value.frame, (await reader.next()).value.frame];
      expect({ rejectedItems, rejectedSnapshot, frames }).toEqual({
        rejectedItems: initial,
        rejectedSnapshot: { entries: initial },
        frames: [
          { type: "patch", delete: ["renewed"] },
          { type: "patch", set: { renewed: "replacement" } },
        ],
      });
      expect(Object.fromEntries(host.items)).toEqual({ preserved: "keep", renewed: "replacement" });
    } finally {
      await reader.return?.();
      root.dispose();
    }
  } finally {
    await modules.close();
  }
});
