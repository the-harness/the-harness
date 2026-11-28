import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type GatewayModule = typeof import("../../packages/gateway/src/index.ts");
type RpcModule = typeof import("../../packages/rpc/src/index.ts");
type StreamModule = typeof import("../../packages/stream/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type TransportModule = typeof import("../../packages/transport/src/index.ts");

let harness: HarnessModules;
let gateway: GatewayModule;
let rpc: RpcModule;
let stream: StreamModule;
let di: DiModule;
let transports: TransportModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [gateway, rpc, stream, di, transports] = await Promise.all([
    harness.load<GatewayModule>("/packages/gateway/src/index.ts"),
    harness.load<RpcModule>("/packages/rpc/src/index.ts"),
    harness.load<StreamModule>("/packages/stream/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<TransportModule>("/packages/transport/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

it("routes pending RPCs to the harness selected when each request starts", async () => {
  const server = createServer();
  gateway.attachGateway(server, async (harnessId) => ({
    rpcServer: { handleCall: async () => harnessId },
    streamServer: { handleStream: async function* () {} },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const scope = di.createRootScope();
  try {
    const port = (server.address() as AddressInfo).port;
    vi.stubGlobal("location", { protocol: "http:", host: `127.0.0.1:${port}` });
    scope.provide(transports.WebTransportConnection);
    const connection = scope.get(transports.WebTransportConnection);

    connection.setHarnessId("first");
    const first = connection.request([], "/rpc/runtime.target");
    connection.setHarnessId("second");
    const second = connection.request([], "/rpc/runtime.target");

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  } finally {
    try {
      scope.dispose();
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

interface Frame {
  readonly type: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly data?: unknown;
}

class FrameRecorder {
  readonly frames: Frame[] = [];
  private readonly waiters: Array<{
    readonly predicate: (frames: readonly Frame[]) => boolean;
    readonly resolve: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(frame: Frame): void {
    this.frames.push(frame);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(this.frames)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  waitFor(predicate: (frames: readonly Frame[]) => boolean, label: string): Promise<void> {
    if (predicate(this.frames)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${label}`));
      }, 10_000);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }
}

interface Client {
  readonly recorder: FrameRecorder;
  send(frame: unknown): void;
  close(): Promise<void>;
}

async function openClient(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/transport/ws`);
  const recorder = new FrameRecorder();
  socket.addEventListener("message", (event) => {
    recorder.push(JSON.parse(String(event.data)) as Frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  return {
    recorder,
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true }),
      );
      socket.close();
      await closed;
    },
  };
}

interface GatewayHarness {
  readonly port: number;
  readonly rpcServer: InstanceType<RpcModule["RpcServerService"]>;
  readonly streamServer: InstanceType<StreamModule["StreamServerService"]>;
  readonly resolvedIds: Array<string | undefined>;
  close(): Promise<void>;
}

async function createGateway(): Promise<GatewayHarness> {
  const rpcServer = new rpc.RpcServerService();
  const streamServer = new stream.StreamServerService();
  const resolvedIds: Array<string | undefined> = [];
  const server = createServer();
  gateway.attachGateway(server, async (harnessId) => {
    resolvedIds.push(harnessId);
    if (harnessId === "missing") throw new Error("unknown harness");
    return { rpcServer, streamServer };
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    rpcServer,
    streamServer,
    resolvedIds,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const passthrough = { parse: (value: unknown) => value };

function echoContract() {
  return rpc.defineRpcContract("demo", {
    echo: rpc.rpc.call(passthrough, passthrough),
  });
}

it("dispatches only to the registration that owns a completed runtime resolution", async () => {
  type Runtime = import("../../packages/transport/src/index.ts").RootServerTransport;
  const resolutionStarted = Promise.withResolvers<void>();
  const oldResolution = Promise.withResolvers<Runtime>();
  const oldCall = vi.fn(async () => "retired");
  const newCall = vi.fn(async () => "current");
  const handleStream = async function* () {};
  class MockRootServerTransport extends transports.RootServerTransport {
    constructor(
      private readonly onCall: typeof oldCall,
      private readonly onStream: typeof handleStream,
    ) {
      super();
    }

    override handleCall(scope: readonly string[], path: string, body: unknown, signal: AbortSignal) {
      return this.onCall(scope, path, body, signal);
    }

    override handleStream(
      scope: readonly string[],
      path: string,
      body: unknown,
      signal: AbortSignal,
    ) {
      return this.onStream(scope, path, body, signal);
    }
  }
  const oldRuntime = new MockRootServerTransport(oldCall, handleStream);
  const newRuntime = new MockRootServerTransport(newCall, handleStream);
  let resolution = oldResolution.promise;
  const dispose = vi.fn();
  const registration = {
    meta: { harnessId: "worker", name: "Worker", kind: "test" },
    resolveRuntime() {
      resolutionStarted.resolve();
      return resolution;
    },
    dispose,
  };
  const registry = gateway.createHarnessRegistry();
  registry.register(registration);
  expect(() => registry.register({ ...registration })).toThrow(
    "Harness 'worker' is already registered",
  );

  const server = createServer();
  gateway.attachGateway(server, registry);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  let client: Client | undefined;
  try {
    client = await openClient((server.address() as AddressInfo).port);
    client.send({ type: "request", id: "old", path: "/rpc/demo.echo" });
    await resolutionStarted.promise;

    await registry.unregister("worker");
    expect(dispose).toHaveBeenCalledTimes(1);
    resolution = Promise.resolve(newRuntime);
    registry.register(registration);
    oldResolution.resolve(oldRuntime);
    client.send({ type: "request", id: "new", path: "/rpc/demo.echo" });
    await client.recorder.waitFor(
      (frames) => frames.filter((frame) => frame.type === "response").length === 2,
      "responses from both runtime resolutions",
    );

    const responses = client.recorder.ofType("response");
    expect(responses.find((frame) => frame.id === "old")).toMatchObject({
      ok: false,
      error: "Harness 'worker' was unregistered during runtime resolution",
    });
    expect(responses.find((frame) => frame.id === "new")).toMatchObject({
      ok: true,
      result: "current",
    });
    expect(oldCall).not.toHaveBeenCalled();
    expect(newCall).toHaveBeenCalledTimes(1);
  } finally {
    oldResolution.resolve(oldRuntime);
    await client?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.unregister("worker");
  }
});

describe("websocket gateway", () => {
  it("round-trips RPC and streams through the real DI transport and gateway", async () => {
    const gatewayHarness = await createGateway();
    const scope = di.createRootScope();
    try {
      vi.stubGlobal("location", {
        protocol: "http:",
        host: `127.0.0.1:${gatewayHarness.port}`,
      });
      scope.provideAll([
        transports.WebTransportConnection,
        [transports.Transport, di.createDescriptor(transports.WebTransport, ["session", "s1"])],
      ]);
      const transport = scope.createInstance(scope.get(transports.Transport).childScope("workspace"));
      gatewayHarness.rpcServer.useHandlers(echoContract(), {
        echo: (input, ctx) => ({ input, scope: ctx.scope }),
      });
      const countContract = stream.defineStreamContract("demo", {
        count: stream.stream.channel(passthrough, passthrough),
      });
      gatewayHarness.streamServer.useHandlers(countContract, {
        count: async function* (input, ctx) {
          for (let index = 0; index < input.count; index++) {
            yield { index, scope: ctx.scope };
          }
        },
      });

      await expect(transport.request("/rpc/demo.echo", { text: "你好" })).resolves.toEqual({
        input: { text: "你好" },
        scope: ["session", "s1", "workspace"],
      });
      await expect(transport.request("/rpc/demo.missing")).rejects.toThrow(
        "Unknown RPC call route",
      );
      const chunks: unknown[] = [];
      for await (const chunk of transport.openStream("/stream/demo.count", { count: 2 })) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([
        { index: 0, scope: ["session", "s1", "workspace"] },
        { index: 1, scope: ["session", "s1", "workspace"] },
      ]);
    } finally {
      try {
        scope.dispose();
      } finally {
        vi.unstubAllGlobals();
        await gatewayHarness.close();
      }
    }
  });

  it("routes an RPC call with its scope and serializes the handler result", async () => {
    const gatewayHarness = await createGateway();
    const seen: Array<{ input: unknown; scope: readonly string[] }> = [];
    gatewayHarness.rpcServer.useHandlers(echoContract(), {
      echo: (input, ctx) => {
        seen.push({ input, scope: ctx.scope });
        return { echoed: input, scoped: ctx.scope.length > 0 };
      },
    });
    const client = await openClient(gatewayHarness.port);
    try {
      client.send({
        type: "request",
        id: "rpc-1",
        scope: ["session", "s1"],
        path: "/rpc/demo.echo",
        body: { value: 42 },
      });
      await client.recorder.waitFor(
        (frames) => frames.some((frame) => frame.type === "response"),
        "RPC response",
      );
      expect(client.recorder.ofType("response")[0]).toEqual({
        type: "response",
        id: "rpc-1",
        ok: true,
        result: { echoed: { value: 42 }, scoped: true },
      });
      expect(seen).toEqual([{ input: { value: 42 }, scope: ["session", "s1"] }]);
    } finally {
      await client.close();
      await gatewayHarness.close();
    }
  });

  it.each(["local cancellation", "cancellation after remote EOF", "remote EOF", "remote error"])(
    "handles buffered stream chunks after %s through the real gateway",
    async (finish) => {
      const gatewayHarness = await createGateway();
      const scope = di.createRootScope();
      const sent = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const keepOpen = finish === "local cancellation";
      try {
        vi.stubGlobal("location", {
          protocol: "http:",
          host: `127.0.0.1:${gatewayHarness.port}`,
        });
        scope.provideAll([
          transports.WebTransportConnection,
          [transports.Transport, transports.WebTransport],
        ]);
        const transport = scope.get(transports.Transport);
        const contract = stream.defineStreamContract("demo", {
          buffered: stream.stream.channel(passthrough, passthrough),
        });
        scope.run(() => {
          gatewayHarness.rpcServer.useHandlers(echoContract(), { echo: (input) => input });
          gatewayHarness.streamServer.useHandlers(contract, {
            buffered: async function* (_input, ctx) {
              yield "first";
              yield "buffered";
              sent.resolve();
              if (finish === "remote error") throw new Error("remote stream failed");
              if (keepOpen) {
                await new Promise<void>((resolve) =>
                  ctx.signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                closed.resolve();
              }
            },
          });
        });

        const controller = new AbortController();
        const subscription = transport.openStream("/stream/demo.buffered", {}, controller.signal);
        const events = subscription[Symbol.asyncIterator]();
        await expect(events.next()).resolves.toEqual({ value: "first", done: false });
        await sent.promise;
        // The RPC response follows the buffered chunk and any terminal frame on the same socket.
        await expect(transport.request("/rpc/demo.echo", "received")).resolves.toBe("received");

        if (keepOpen || finish === "cancellation after remote EOF") {
          const reason = new Error("subscriber canceled");
          controller.abort(reason);
          await expect(events.next()).rejects.toBe(reason);
          if (keepOpen) await closed.promise;
          return;
        }
        await expect(events.next()).resolves.toEqual({ value: "buffered", done: false });
        if (finish === "remote error") {
          await expect(events.next()).rejects.toThrow("remote stream failed");
        } else {
          await expect(events.next()).resolves.toEqual({ value: undefined, done: true });
        }
      } finally {
        try {
          scope.dispose();
        } finally {
          vi.unstubAllGlobals();
          await gatewayHarness.close();
        }
      }
    },
  );

  it("returns protocol errors for unknown routes, failing handlers and unknown harnesses", async () => {
    const gatewayHarness = await createGateway();
    gatewayHarness.rpcServer.useHandlers(echoContract(), {
      echo: () => {
        throw new Error("handler exploded");
      },
    });
    const client = await openClient(gatewayHarness.port);
    try {
      client.send({ type: "request", id: "missing-route", path: "/rpc/demo.nope", body: {} });
      client.send({ type: "request", id: "failing", path: "/rpc/demo.echo", body: {} });
      client.send({
        type: "request",
        id: "missing-harness",
        harnessId: "missing",
        path: "/rpc/demo.echo",
        body: {},
      });
      await client.recorder.waitFor(
        (frames) => frames.filter((frame) => frame.type === "response").length === 3,
        "three error responses",
      );
      const responses = client.recorder.ofType("response");
      expect(responses.every((frame) => frame.ok === false)).toBe(true);
      expect(responses.find((frame) => frame.id === "missing-route")?.error).toContain(
        "Unknown RPC call route",
      );
      expect(responses.find((frame) => frame.id === "failing")?.error).toBe("handler exploded");
      expect(responses.find((frame) => frame.id === "missing-harness")?.error).toBe(
        "unknown harness",
      );
      expect(gatewayHarness.resolvedIds).toContain("missing");
    } finally {
      await client.close();
      await gatewayHarness.close();
    }
  });

  it("streams chunks and completes with an end frame", async () => {
    const gatewayHarness = await createGateway();
    const countContract = stream.defineStreamContract("demo", {
      count: stream.stream.channel(passthrough, passthrough),
    });
    gatewayHarness.streamServer.useHandlers(countContract, {
      count: async function* (input) {
        for (let i = 1; i <= input.count; i++) yield { index: i };
      },
    });
    const client = await openClient(gatewayHarness.port);
    try {
      client.send({
        type: "stream:open",
        id: "stream-1",
        scope: [],
        path: "/stream/demo.count",
        body: { count: 3 },
      });
      await client.recorder.waitFor(
        (frames) => frames.some((frame) => frame.type === "stream:end"),
        "stream completion",
      );
      expect(client.recorder.ofType("stream:data").map((frame) => frame.data)).toEqual([
        { index: 1 },
        { index: 2 },
        { index: 3 },
      ]);
      expect(client.recorder.ofType("stream:error")).toEqual([]);
    } finally {
      await client.close();
      await gatewayHarness.close();
    }
  });

  it("aborts the server stream when the client closes it", async () => {
    const gatewayHarness = await createGateway();
    let aborted!: () => void;
    const abortObserved = new Promise<void>((resolve) => (aborted = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const observed: Array<{ aborted: boolean }> = [];
    const countContract = stream.defineStreamContract("demo", {
      endless: stream.stream.channel(passthrough, passthrough),
    });
    gatewayHarness.streamServer.useHandlers(countContract, {
      endless: async function* (_input, ctx) {
        yield { first: true };
        ctx.signal?.addEventListener(
          "abort",
          () => {
            observed.push({ aborted: true });
            aborted();
          },
          { once: true },
        );
        await released;
        yield { leaked: true };
      },
    });
    const client = await openClient(gatewayHarness.port);
    try {
      client.send({
        type: "stream:open",
        id: "endless",
        scope: [],
        path: "/stream/demo.endless",
        body: {},
      });
      await client.recorder.waitFor(
        (frames) => frames.some((frame) => frame.type === "stream:data"),
        "first stream chunk",
      );
      client.send({ type: "stream:close", id: "endless" });
      await abortObserved;
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(observed).toEqual([{ aborted: true }]);
      expect(client.recorder.ofType("stream:data")).toEqual([
        { type: "stream:data", id: "endless", data: { first: true } },
      ]);
      expect(client.recorder.ofType("stream:end")).toEqual([]);
    } finally {
      await client.close();
      await gatewayHarness.close();
    }
  });
});
