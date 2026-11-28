import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessMetadata, HarnessRegistration } from "@harness/gateway";
import { RootServerTransport } from "@harness/transport";

export { serveStdioRuntime } from "./server.ts";

export interface StdioHarnessOptions {
  readonly meta: HarnessMetadata;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type ServerFrame =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly result?: unknown }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: string }
  | { readonly type: "stream:data"; readonly id: string; readonly data: unknown }
  | { readonly type: "stream:end"; readonly id: string }
  | { readonly type: "stream:error"; readonly id: string; readonly error: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface StreamSink {
  push: (value: unknown) => void;
  end: () => void;
  fail: (reason: unknown) => void;
}

class StdioRootServerTransport extends RootServerTransport {
  constructor(private readonly harness: StdioHarnessService) {
    super();
  }

  override handleCall(scope: readonly string[], route: string, body: unknown) {
    return this.harness.handleCall(route, scope, body);
  }

  override handleStream(
    scope: readonly string[],
    path: string,
    body: unknown,
    signal: AbortSignal,
  ) {
    return this.harness.handleStream(path, scope, body, signal);
  }
}

export class StdioHarnessService {
  readonly meta: HarnessMetadata;
  private readonly options: StdioHarnessOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private disposed = false;
  private nextId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeStreams = new Map<string, StreamSink>();
  private readonly serverTransport: RootServerTransport;

  constructor(options: StdioHarnessOptions) {
    this.options = options;
    this.meta = options.meta;

    this.serverTransport = new StdioRootServerTransport(this);
  }

  async resolveRuntime(): Promise<RootServerTransport> {
    this.ensureProcess();
    return this.serverTransport;
  }

  toRegistration(): HarnessRegistration {
    return {
      meta: this.meta,
      resolveRuntime: () => this.resolveRuntime(),
      dispose: () => this.dispose(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.child) {
      const proc = this.child;
      this.child = null;
      proc.stdin.end();
      proc.kill();
    }
    this.failAll(new Error("Stdio harness disposed"));
  }

  private handleCall(route: string, scope: readonly string[], body: unknown): Promise<unknown> {
    const id = `rpc-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.sendFrame({ type: "request", id, scope, path: `/rpc/${route}`, body });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private async *handleStream(
    path: string,
    scope: readonly string[],
    body: unknown,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    if (signal.aborted) return;
    const id = `stream-${this.nextId++}`;
    const openFrame = JSON.stringify({ type: "stream:open", id, scope, path, body });
    if (signal.aborted) return;
    const child = this.ensureProcess();
    const queue: unknown[] = [];
    let ended = false;
    let failure: unknown = null;
    let notify: (() => void) | undefined;

    this.activeStreams.set(id, {
      push: (value) => {
        queue.push(value);
        notify?.();
        notify = undefined;
      },
      end: () => {
        ended = true;
        notify?.();
        notify = undefined;
      },
      fail: (reason) => {
        failure = reason;
        ended = true;
        notify?.();
        notify = undefined;
      },
    });

    const close = () => {
      const active = this.activeStreams.delete(id);
      if (!active || child.killed || child.exitCode !== null || !child.stdin.writable) return;
      try {
        child.stdin.write(`${JSON.stringify({ type: "stream:close", id })}\n`);
      } catch {
        // The child may have already closed its input.
      }
    };
    const onAbort = () => {
      ended = true;
      queue.length = 0;
      close();
      notify?.();
      notify = undefined;
    };

    signal.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin.write(`${openFrame}\n`);
      while (true) {
        while (queue.length > 0) {
          yield queue.shift();
        }
        if (ended) {
          if (failure !== null && !signal.aborted) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      close();
    }
  }

  private sendFrame(frame: unknown): void {
    this.ensureProcess().stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private failAll(reason: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
    for (const sink of this.activeStreams.values()) {
      sink.fail(reason);
    }
    this.activeStreams.clear();
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.disposed) {
      throw new Error("Stdio harness disposed");
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    const proc = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = proc;

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onStdoutLine(line));

    proc.once("exit", (code, signal) => {
      rl.close();
      if (this.child === proc) this.child = null;
      this.failAll(
        new Error(`Stdio harness exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    proc.once("error", (err) => {
      rl.close();
      if (this.child === proc) this.child = null;
      this.failAll(err);
    });

    return proc;
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(line) as ServerFrame;
    } catch {
      return;
    }

    if (frame.type === "response") {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) return;
      this.pendingRequests.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(new Error(frame.error));
      }
      return;
    }

    const sink = this.activeStreams.get(frame.id);
    if (!sink) return;
    if (frame.type === "stream:data") {
      sink.push(frame.data);
    } else if (frame.type === "stream:end") {
      this.activeStreams.delete(frame.id);
      sink.end();
    } else if (frame.type === "stream:error") {
      this.activeStreams.delete(frame.id);
      sink.fail(new Error(frame.error));
    }
  }
}
