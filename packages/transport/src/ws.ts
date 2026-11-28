import { createDescriptor, inject, type Descriptor } from "@harness/di";
import { onScopeDispose } from "reactivity";
import { Transport } from "./transport.ts";

type ClientFrame =
  | {
      type: "request";
      id: string;
      harnessId?: string;
      scope: readonly string[];
      path: string;
      body?: unknown;
    }
  | {
      type: "request:cancel";
      id: string;
    }
  | {
      type: "stream:open";
      id: string;
      harnessId?: string;
      scope: readonly string[];
      path: string;
      body?: unknown;
    }
  | {
      type: "stream:close";
      id: string;
    };

type ServerFrame =
  | {
      type: "ready";
      id: string;
      surfaceId: string;
      role: "owner" | "observer";
    }
  | {
      type: "pong";
      id: string;
    }
  | {
      type: "response";
      id: string;
      ok: true;
      result?: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: string;
    }
  | {
      type: "stream:data";
      id: string;
      data: unknown;
    }
  | {
      type: "stream:end";
      id: string;
    }
  | {
      type: "stream:error";
      id: string;
      error: string;
    };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface StreamSink {
  push: (value: unknown) => void;
  end: () => void;
  fail: (reason: unknown) => void;
}

export class WebTransportConnection {
  private ws: WebSocket | null = null;
  private disposed = false;
  private connectPromise: Promise<WebSocket> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private harnessId: string | undefined;
  private nextId = 1;
  private readonly surfaceId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeStreams = new Map<string, StreamSink>();

  constructor() {
    onScopeDispose(() => {
      this.disposed = true;
      this.stopHeartbeat();
      this.ws?.close();
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.lastActivity = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastActivity > 45_000) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "ping", id: `ping-${this.nextId++}` }));
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  setHarnessId(harnessId: string | undefined): void {
    this.harnessId = harnessId;
  }

  getHarnessId(): string | undefined {
    return this.harnessId;
  }

  private getUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/api/transport/ws`;
  }

  private ensureConnected(): Promise<WebSocket> {
    if (this.disposed) {
      return Promise.reject(new Error("WebSocket transport has been disposed"));
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.getUrl());
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connectPromise = null;
        ws.send(
          JSON.stringify({
            type: "hello",
            id: `hello-${this.nextId++}`,
            surfaceId: this.surfaceId,
            role: "owner",
          }),
        );
        this.startHeartbeat(ws);
        resolve(ws);
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      ws.addEventListener("error", () => {
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(new Error("WebSocket connection failed"));
        }
      });

      ws.addEventListener("close", () => {
        this.stopHeartbeat();
        if (this.ws === ws) {
          this.ws = null;
        }
        this.connectPromise = null;
        const err = new Error("WebSocket connection closed");
        for (const pending of this.pendingRequests.values()) {
          pending.reject(err);
        }
        this.pendingRequests.clear();
        for (const stream of this.activeStreams.values()) {
          stream.fail(err);
        }
        this.activeStreams.clear();
      });
    });

    return this.connectPromise;
  }

  private handleMessage(raw: unknown): void {
    this.lastActivity = Date.now();
    if (typeof raw !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    if (frame.type === "ready" || frame.type === "pong") {
      return;
    }

    if (frame.type === "response") {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) return;
      this.pendingRequests.delete(frame.id);
      if (frame.ok || !("error" in frame)) {
        pending.resolve(frame.result);
      } else {
        const rawError: unknown = frame.error;
        const errMsg =
          typeof rawError === "string"
            ? rawError
            : typeof rawError === "object" && rawError !== null && "message" in rawError
              ? String((rawError as { message: unknown }).message)
              : JSON.stringify(rawError);
        pending.reject(new Error(errMsg || `Unknown RPC error (frame: ${JSON.stringify(frame)})`));
      }
      return;
    }

    const stream = this.activeStreams.get(frame.id);
    if (!stream) return;

    if (frame.type === "stream:data") {
      stream.push(frame.data);
    } else if (frame.type === "stream:end") {
      this.activeStreams.delete(frame.id);
      stream.end();
    } else if (frame.type === "stream:error") {
      this.activeStreams.delete(frame.id);
      stream.fail(new Error(frame.error));
    }
  }

  private async send(frame: ClientFrame): Promise<void> {
    const ws = await this.ensureConnected();
    ws.send(JSON.stringify(frame));
  }

  async request(
    scope: readonly string[],
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const harnessId = this.harnessId;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const id = String(this.nextId++);
    return await new Promise<unknown>((resolve, reject) => {
      let requestSocket: WebSocket | undefined;
      const onAbort = () => {
        this.pendingRequests.delete(id);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (requestSocket?.readyState === WebSocket.OPEN) {
          requestSocket.send(JSON.stringify({ type: "request:cancel", id } satisfies ClientFrame));
        }
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingRequests.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      });

      this.ensureConnected()
        .then((socket) => {
          if (!this.pendingRequests.has(id)) return;
          const frame = JSON.stringify({
            type: "request",
            id,
            ...(harnessId ? { harnessId } : {}),
            scope,
            path,
            body,
          } satisfies ClientFrame);
          if (signal?.aborted) return;
          socket.send(frame);
          requestSocket = socket;
        })
        .catch((err) => {
          const pending = this.pendingRequests.get(id);
          this.pendingRequests.delete(id);
          pending?.reject(err);
        });
    });
  }

  async *openStream(
    scope: readonly string[],
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const id = String(this.nextId++);
    const queue: unknown[] = [];
    let ended = false;
    let failure: unknown = undefined;
    let hasFailure = false;
    let notify: (() => void) | null = null;

    const wake = () => {
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    };

    this.activeStreams.set(id, {
      push: (value) => {
        queue.push(value);
        wake();
      },
      end: () => {
        ended = true;
        wake();
      },
      fail: (reason) => {
        hasFailure = true;
        failure = reason;
        wake();
      },
    });

    const onAbort = () => {
      this.activeStreams.delete(id);
      wake();
      void this.send({ type: "stream:close", id }).catch(() => {});
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.send({
        type: "stream:open",
        id,
        ...(this.harnessId ? { harnessId: this.harnessId } : {}),
        scope,
        path,
        body,
      });

      while (true) {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (hasFailure) {
          throw failure;
        }
        if (ended) {
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.activeStreams.delete(id)) {
        void this.send({ type: "stream:close", id }).catch(() => {});
      }
    }
  }
}

export class WebTransport extends Transport {
  private readonly connection = inject(WebTransportConnection);
  private readonly scopePath: readonly string[];

  constructor(scopePath: readonly string[] = []) {
    super();
    this.scopePath = scopePath;
  }

  override childScope(id: string): Descriptor<Transport> {
    return createDescriptor(WebTransport, [...this.scopePath, id]);
  }

  override request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.connection.request(this.scopePath, path, body, signal);
  }

  override openStream(path: string, body?: unknown, signal?: AbortSignal): AsyncIterable<unknown> {
    return this.connection.openStream(this.scopePath, path, body, signal);
  }
}
