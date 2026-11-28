import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type RpcModule = typeof import("../../packages/rpc/src/index.ts");
type StateSyncModule = typeof import("../../packages/state-sync/src/index.ts");
type StreamModule = typeof import("../../packages/stream/src/index.ts");
type TransportModule = typeof import("../../packages/transport/src/index.ts");
type ZodModule = { z: typeof import("zod").z };

let harness: HarnessModules;
let di: DiModule;
let rpc: RpcModule;
let stateSync: StateSyncModule;
let stream: StreamModule;
let transport: TransportModule;
let zod: ZodModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, rpc, stateSync, stream, transport, zod] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<RpcModule>("/packages/rpc/src/index.ts"),
    harness.load<StateSyncModule>("/packages/state-sync/src/index.ts"),
    harness.load<StreamModule>("/packages/stream/src/index.ts"),
    harness.load<TransportModule>("/packages/transport/src/index.ts"),
    harness.load<ZodModule>("/packages/state-sync/node_modules/zod/index.js"),
  ]);

  MemoryTransport = class extends transport.Transport {
    private readonly routes: Routes;
    private readonly scopes: readonly string[];

    constructor(routes: Routes, scopes: readonly string[]) {
      super();
      this.routes = routes;
      this.scopes = scopes;
    }

    override request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
      this.routes.scopes = this.scopes;
      return this.routes.request(path, body, signal);
    }

    override openStream(
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): AsyncIterable<unknown> {
      return this.routes.openStream(path, body, signal);
    }

    override childScope(id: string) {
      return di.createDescriptor(MemoryTransport, this.routes, [...this.scopes, id]);
    }
  };
});

afterAll(async () => {
  await harness.close();
});

interface Routes {
  scopes?: readonly string[];
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  openStream(path: string, body?: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
}

let MemoryTransport: new (routes: Routes, scopes: readonly string[]) => transport.Transport;

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createServer() {
  const serverScope = di.createRootScope();
  const serverTransport = new transport.RootServerTransport();
  serverScope.provideAll([
    [transport.ServerTransport, di.createDescriptor(() => serverTransport)],
    rpc.RpcServerService,
    stream.StreamServerService,
    stateSync.StateSyncServerService,
  ]);
  return {
    serverScope,
    serverTransport,
    rpcServer: serverScope.get(rpc.RpcServerService),
    streamServer: serverScope.get(stream.StreamServerService),
    syncServer: serverScope.get(stateSync.StateSyncServerService),
  };
}

function createClientScope(routes: Routes, scopeSegments: readonly string[]) {
  const scope = di.createRootScope();
  scope.provideAll([
    [transport.Transport, di.createDescriptor(MemoryTransport, routes, scopeSegments)],
    rpc.RpcClientService,
    stream.StreamClientService,
    stateSync.StateSyncClientService,
  ]);
  return scope;
}

function createHarness(
  contract: StateSyncModule["StateSyncContract"],
  options: { readonly?: boolean; scope?: readonly string[] } = {},
) {
  const { serverScope, serverTransport, syncServer } = createServer();
  const hosts = new Map<string, any>();
  const scopeSegments = options.scope ?? ["session-a"];
  const hostFor = (scope: readonly string[]) => {
    const key = scope.join("/");
    let host = hosts.get(key);
    if (host === undefined) {
      host = serverScope.run(() => new stateSync.SyncedRecordHost<string>());
      hosts.set(key, host);
    }
    return host;
  };
  serverScope.run(() =>
    syncServer.useHandlers(contract, {
      active: (ctx) => hostFor(ctx.scope),
    } as never),
  );

  const routes: Routes = {
    async request(path, body, signal) {
      const route = path.replace(/^\/rpc\//, "");
      return await serverTransport.handleCall(routes.scopes ?? scopeSegments, route, body, signal);
    },
    openStream(path, body, signal) {
      return serverTransport.handleStream(routes.scopes ?? scopeSegments, path, body, signal);
    },
  };

  const scope = createClientScope(routes, scopeSegments);

  return {
    scope,
    routes,
    hostFor,
    client: () =>
      scope.run(() => scope.get(stateSync.StateSyncClientService).use(contract as never)),
    dispose() {
      scope.dispose();
      serverScope.dispose();
    },
  };
}

describe("state-sync record endpoints", () => {
  it("rejects record and value patches after their host scope retires", async () => {
    const { serverScope, serverTransport, syncServer } = createServer();
    try {
      const contract = stateSync.defineStateSyncContract("retired-primitives", {
        record: stateSync.stateSync.record(zod.z.string()),
        value: stateSync.stateSync.value(zod.z.string()),
      });
      const owner = serverScope.createChild();
      owner.onDispose(() => {
        throw new Error("earlier cleanup failed");
      });
      const retiredRecord = owner.run(
        () => new stateSync.SyncedRecordHost<string>([["original", "record"]]),
      );
      const retiredValue = owner.run(() => new stateSync.SyncedValueHost<string>("original"));
      let record = retiredRecord;
      let value = retiredValue;
      serverScope.run(() =>
        syncServer.useHandlers(contract, {
          record: () => record,
          value: () => value,
        }),
      );
      const recordPatch = { delete: ["original"], set: { new: "record" } };
      const valuePatch = { value: "new" };

      expect(() => owner.dispose()).toThrow("earlier cleanup failed");
      await expect(
        serverTransport.handleCall([], "state-sync:retired-primitives.record", recordPatch),
      ).rejects.toThrow("SyncedRecordHost is disposed");
      await expect(
        serverTransport.handleCall([], "state-sync:retired-primitives.value", valuePatch),
      ).rejects.toThrow("SyncedValueHost is disposed");
      expect([...retiredRecord.items]).toEqual([["original", "record"]]);
      expect(retiredValue.value).toBe("original");

      record = serverScope.run(
        () => new stateSync.SyncedRecordHost<string>([["original", "current"]]),
      );
      value = serverScope.run(() => new stateSync.SyncedValueHost<string>("replacement"));
      await serverTransport.handleCall([], "state-sync:retired-primitives.record", recordPatch);
      await serverTransport.handleCall([], "state-sync:retired-primitives.value", valuePatch);
      expect([...record.items]).toEqual([["new", "record"]]);
      expect(value.value).toBe("new");
    } finally {
      serverScope.dispose();
    }
  });

  it("keeps sending local record edits after a server frame arrives", async () => {
    const contract = stateSync.defineStateSyncContract("nightly", {
      active: stateSync.stateSync.record(zod.z.string()),
    });
    const server = createHarness(contract);
    const host = server.hostFor(["session-a"]);
    host.items.set("a", "one");
    try {
      const client = server.client() as {
        active: InstanceType<StateSyncModule["SyncedRecordClient"]>;
      };
      await waitFor(() => client.active.get("a") === "one", "initial snapshot");

      host.items.set("remote", "from-server");
      await waitFor(() => client.active.get("remote") === "from-server", "remote frame");

      client.active.items.set("local", "from-client");
      await waitFor(() => host.items.get("local") === "from-client", "client patch to host");
      expect([...host.items.keys()]).toEqual(["a", "remote", "local"]);
    } finally {
      server.dispose();
    }
  });

  it("isolates hosts by transport scope", async () => {
    const contract = stateSync.defineStateSyncContract("nightly-scope", {
      active: stateSync.stateSync.record(zod.z.string()),
    });
    const { serverScope, serverTransport, syncServer } = createServer();
    const hosts = new Map<string, any>();
    serverScope.run(() => {
      syncServer.useHandlers(contract, {
        active: (ctx) => hosts.get(ctx.scope.join("/")),
      } as never);
      hosts.set("one", new stateSync.SyncedRecordHost<string>([["a", "first"]]));
      hosts.set("two", new stateSync.SyncedRecordHost<string>([["a", "second"]]));
    });

    const routes: Routes = {
      request: (path, body, signal) =>
        serverTransport.handleCall(["one"], path.replace(/^\/rpc\//, ""), body, signal),
      openStream: (path, body, signal) => serverTransport.handleStream(["one"], path, body, signal),
    };
    const scope = createClientScope(routes, ["one"]);
    try {
      const client = scope.run(() =>
        scope.get(stateSync.StateSyncClientService).use(contract as never),
      ) as {
        active: InstanceType<StateSyncModule["SyncedRecordClient"]>;
      };
      await waitFor(() => client.active.get("a") === "first", "scoped snapshot");
      expect(hosts.get("two")!.items.get("a")).toBe("second");
    } finally {
      scope.dispose();
      serverScope.dispose();
    }
  });

  it("rejects patches and ignores local writes for a readonly endpoint", async () => {
    const contract = stateSync.defineStateSyncContract("nightly-readonly", {
      active: stateSync.stateSync.record(zod.z.string(), { readonly: true }),
    });
    const server = createHarness(contract);
    const host = server.hostFor(["session-a"]);
    host.items.set("a", "one");
    try {
      const client = server.client() as {
        active: InstanceType<StateSyncModule["SyncedRecordClient"]>;
      };
      await waitFor(() => client.active.get("a") === "one", "readonly snapshot");

      client.active.items.set("local", "not-sent");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(host.items.has("local")).toBe(false);

      await expect(
        server.routes.request("/rpc/state-sync:nightly-readonly.active", {
          set: { forced: "no" },
        }),
      ).rejects.toThrow("State-sync path is read-only: /state-sync/nightly-readonly.active");

      host.items.set("b", "two");
      await waitFor(() => client.active.get("b") === "two", "readonly remote frame");
    } finally {
      server.dispose();
    }
  });

  it("releases a registration's streams and resubscribes to the replacement host", async () => {
    const contract = stateSync.defineStateSyncContract("registration-lifecycle", {
      active: stateSync.stateSync.record(zod.z.string()),
    });
    const { serverScope, serverTransport, syncServer } = createServer();
    const routes: Routes = {
      request: (path, body, signal) =>
        serverTransport.handleCall(["session-a"], path.replace(/^\/rpc\//, ""), body, signal),
      openStream: (path, body, signal) =>
        serverTransport.handleStream(["session-a"], path, body, signal),
    };
    const scope = createClientScope(routes, ["session-a"]);
    try {
      const first = serverScope.run(
        () => new stateSync.SyncedRecordHost<string>([["phase", "first"]]),
      );
      const replacement = serverScope.run(
        () => new stateSync.SyncedRecordHost<string>([["phase", "replacement"]]),
      );
      const unsubscribed = vi.fn();
      const subscribe = first.subscribe.bind(first);
      vi.spyOn(first, "subscribe").mockImplementation((listener) => {
        const unsubscribe = subscribe(listener);
        return () => {
          unsubscribe();
          unsubscribed();
        };
      });

      const registration = serverScope.createChild();
      registration.run(() => syncServer.useHandlers(contract, { active: () => first }));
      const client = scope.run(() => scope.get(stateSync.StateSyncClientService).use(contract));
      await expect.poll(() => client.active.get("phase")).toBe("first");
      const paused = serverTransport.handleStream(["session-a"], "/stream/state-sync:registration-lifecycle.active", undefined)
        [Symbol.asyncIterator]();
      expect((await paused.next()).done).toBe(false);

      registration.dispose();
      expect(unsubscribed).toHaveBeenCalledTimes(2);
      expect((await paused.next()).done).toBe(true);
      serverScope.run(() => syncServer.useHandlers(contract, { active: () => replacement }));
      await expect.poll(() => client.active.get("phase"), { timeout: 3_000 }).toBe("replacement");

      client.active.items.set("client", "update");
      await expect.poll(() => replacement.items.get("client")).toBe("update");
      expect(first.items.has("client")).toBe(false);
    } finally {
      scope.dispose();
      serverScope.dispose();
    }
  });

  it("skips a patch when its StateSync registration or RPC request ends during host resolution", async () => {
    const { serverScope, serverTransport, syncServer } = createServer();
    const contract = stateSync.defineStateSyncContract("patch-lifetime", {
      active: stateSync.stateSync.record(zod.z.string()),
    });
    const route = "state-sync:patch-lifetime.active";
    const registration = serverScope.createChild();
    const replacement = serverScope.createChild();
    const canceled = new AbortController();
    const reason = new Error("patch caller closed");
    try {
      const oldHost = serverScope.run(() => new stateSync.SyncedRecordHost<string>());
      const newHost = serverScope.run(() => new stateSync.SyncedRecordHost<string>());
      registration.run(() =>
        syncServer.useHandlers(contract, {
          active: () => {
            registration.dispose();
            replacement.run(() =>
              syncServer.useHandlers(contract, {
                active: () => {
                  canceled.abort(reason);
                  return newHost;
                },
              }),
            );
            return oldHost;
          },
        }),
      );

      await expect(
        serverTransport.handleCall([], route, { set: { value: "old route" } }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(oldHost.items.has("value")).toBe(false);

      await expect(
        serverTransport.handleCall([], route, { set: { value: "canceled" } }, canceled.signal),
      ).rejects.toBe(reason);
      expect(newHost.items.has("value")).toBe(false);

      await serverTransport.handleCall([], route, { set: { value: "current" } });
      expect(newHost.items.get("value")).toBe("current");
    } finally {
      serverScope.dispose();
    }
  });

  it("serializes value hosts and clients without echoing resets", () => {
    const frames: unknown[] = [];
    const owner = di.createRootScope();
    const host = owner.run(() => new stateSync.SyncedValueHost("a"));
    const unsubscribe = host.subscribe((frame) => frames.push(frame));
    try {
      host.value = "b";
      expect(frames).toEqual([{ type: "value", value: "b" }]);
      expect(host.snapshot()).toEqual({ value: "b" });

      host.apply({ value: "c" });
      expect(host.value).toBe("c");
      expect(frames).toHaveLength(2);
    } finally {
      unsubscribe();
      owner.dispose();
    }

    const resent: unknown[] = [];
    const client = new stateSync.SyncedValueClient<string>({
      send: (patch) => resent.push(patch),
    });
    client.reset({ value: "server" });
    expect(client.value).toBe("server");
    expect(resent).toEqual([]);
    client.value = "local";
    expect(resent).toEqual([{ value: "local" }]);
    client.receive({ type: "value", value: "remote" });
    expect(client.value).toBe("remote");
  });
});
