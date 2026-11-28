import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type TransportModule = typeof import("../../packages/transport/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let transports: TransportModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, transports] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<TransportModule>("/packages/transport/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

interface SentFrame {
  readonly type: string;
  readonly id?: string;
  readonly scope?: readonly string[];
  readonly path?: string;
  readonly body?: unknown;
}

type Listener = (event: { readonly data?: unknown }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: SentFrame[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  private emit(type: string, event: { readonly data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 500; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let scope: ReturnType<DiModule["createRootScope"]> | undefined;
let transport: InstanceType<TransportModule["Transport"]>;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "harness.test" });
  scope = di.createRootScope();
  scope.provideAll([
    transports.WebTransportConnection,
    [transports.Transport, di.createDescriptor(transports.WebTransport, ["session", "s1"])],
  ]);
  transport = scope.get(transports.Transport);
});

afterEach(() => {
  try {
    scope?.dispose();
  } finally {
    scope = undefined;
    for (const socket of FakeWebSocket.instances) socket.close();
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
  }
});

async function socket(): Promise<FakeWebSocket> {
  await waitFor(() => FakeWebSocket.instances.length > 0, "websocket instance");
  const instance = FakeWebSocket.instances.at(-1)!;
  await waitFor(() => instance.readyState === FakeWebSocket.OPEN, "websocket open");
  return instance;
}

async function sentFrame(type: string, path: string) {
  const ws = await socket();
  const find = () => ws.sent.find((frame) => frame.type === type && frame.path === path);
  await waitFor(() => find() !== undefined, `${type} ${path}`);
  const frame = find()!;
  expect(frame.id).toEqual(expect.any(String));
  return { ws, frame };
}

describe("websocket transport client", () => {
  it("sends scoped requests and resolves response frames", async () => {
    const scoped = scope!.createInstance(transport.childScope("workspace"));
    const result = scoped.request("/rpc/demo.echo", { value: 1 });
    const { ws, frame } = await sentFrame("request", "/rpc/demo.echo");
    expect(frame).toEqual({
      type: "request",
      id: frame.id,
      scope: ["session", "s1", "workspace"],
      path: "/rpc/demo.echo",
      body: { value: 1 },
    });
    expect(ws.url).toBe("ws://harness.test/api/transport/ws");
    ws.serverSend({ type: "response", id: frame.id, ok: true, result: { echoed: true } });
    await expect(result).resolves.toEqual({ echoed: true });
  });

  it("accepts responses without ok and formats string, object and missing errors", async () => {
    const withoutOk = transport.request("/rpc/demo.one");
    const { ws, frame: compat } = await sentFrame("request", "/rpc/demo.one");
    ws.serverSend({ type: "response", id: compat.id, result: "legacy" });
    await expect(withoutOk).resolves.toBe("legacy");

    const objectError = transport.request("/rpc/demo.two");
    const objectRejected = expect(objectError).rejects.toThrow("object failure");
    const { frame: objectFrame } = await sentFrame("request", "/rpc/demo.two");
    ws.serverSend({
      type: "response",
      id: objectFrame.id,
      ok: false,
      error: { message: "object failure" },
    });
    await objectRejected;

    const stringError = transport.request("/rpc/demo.three");
    const stringRejected = expect(stringError).rejects.toThrow("string failure");
    const { frame: stringFrame } = await sentFrame("request", "/rpc/demo.three");
    ws.serverSend({ type: "response", id: stringFrame.id, ok: false, error: "string failure" });
    await stringRejected;

    const missingError = transport.request("/rpc/demo.four");
    const missingRejected = expect(missingError).rejects.toThrow("Unknown RPC error");
    const { frame: missing } = await sentFrame("request", "/rpc/demo.four");
    ws.serverSend({ type: "response", id: missing.id, ok: false, error: "" });
    await missingRejected;
  });

  it("rejects an aborted request without leaving it pending", async () => {
    const controller = new AbortController();
    const pending = transport.request("/rpc/demo.slow", undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    const { ws, frame: cancelled } = await sentFrame("request", "/rpc/demo.slow");
    controller.abort(new Error("cancelled"));
    await rejected;

    const followUp = transport.request("/rpc/demo.after-abort");
    const { frame: active } = await sentFrame("request", "/rpc/demo.after-abort");
    expect(active.id).not.toBe(cancelled.id);
    ws.serverSend({ type: "response", id: cancelled.id, ok: true, result: "late" });
    ws.serverSend({ type: "response", id: active.id, ok: true, result: "fresh" });
    await expect(followUp).resolves.toBe("fresh");
  });

  it("streams chunks in order until end and forwards a stream error", async () => {
    const iterator = transport
      .openStream("/stream/demo.count", { count: 2 })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    const { ws, frame: open } = await sentFrame("stream:open", "/stream/demo.count");
    expect(open).toMatchObject({
      type: "stream:open",
      scope: ["session", "s1"],
      path: "/stream/demo.count",
      body: { count: 2 },
    });

    ws.serverSend({ type: "stream:data", id: open.id, data: 1 });
    await expect(first).resolves.toEqual({ done: false, value: 1 });
    const second = iterator.next();
    ws.serverSend({ type: "stream:data", id: open.id, data: 2 });
    await expect(second).resolves.toEqual({ done: false, value: 2 });
    const end = iterator.next();
    ws.serverSend({ type: "stream:end", id: open.id });
    await expect(end).resolves.toEqual({ done: true, value: undefined });

    const failing = transport.openStream("/stream/demo.fail")[Symbol.asyncIterator]();
    const failedNext = failing.next();
    const rejected = expect(failedNext).rejects.toThrow("stream exploded");
    const { frame: failedOpen } = await sentFrame("stream:open", "/stream/demo.fail");
    ws.serverSend({ type: "stream:error", id: failedOpen.id, error: "stream exploded" });
    await rejected;
  });

  it("sends stream:close when an active stream is aborted", async () => {
    const controller = new AbortController();
    const iterator = transport
      .openStream("/stream/demo.endless", undefined, controller.signal)
      [Symbol.asyncIterator]();
    const next = iterator.next();
    const rejected = expect(next).rejects.toThrow("stop stream");
    const { ws, frame: open } = await sentFrame("stream:open", "/stream/demo.endless");
    controller.abort(new Error("stop stream"));
    await rejected;
    await waitFor(
      () => ws.sent.some((frame) => frame.type === "stream:close" && frame.id === open.id),
      "stream close frame",
    );
  });

  it("rejects every pending request and stream when the connection closes", async () => {
    const pending = transport.request("/rpc/demo.after-close");
    const another = transport.request("/rpc/demo.another");
    const iterator = transport.openStream("/stream/demo.active")[Symbol.asyncIterator]();
    const closed = Promise.all([
      expect(pending).rejects.toThrow("WebSocket connection closed"),
      expect(another).rejects.toThrow("WebSocket connection closed"),
      expect(iterator.next()).rejects.toThrow("WebSocket connection closed"),
    ]);
    const { ws } = await sentFrame("request", "/rpc/demo.after-close");
    await sentFrame("request", "/rpc/demo.another");
    await sentFrame("stream:open", "/stream/demo.active");
    ws.close();
    await closed;
  });

  it("closes its connection on scope disposal and refuses further requests", async () => {
    const pending = transport.request("/rpc/demo.disposal");
    const rejected = expect(pending).rejects.toThrow("WebSocket connection closed");
    const { ws } = await sentFrame("request", "/rpc/demo.disposal");
    scope!.dispose();
    await rejected;
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    await expect(transport.request("/rpc/demo.disposed")).rejects.toThrow(
      "WebSocket transport has been disposed",
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
