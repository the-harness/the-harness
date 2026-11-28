import { afterEach, describe, expect, test } from "vite-plus/test";
import { createHarnessRegistry } from "../packages/gateway/src/index.ts";
import { StdioHarnessService } from "../packages/harness-stdio/src/index.ts";

describe("harness-stdio end-to-end", () => {
  const disposables: Array<() => void> = [];

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.();
    }
  });

  function createService(): StdioHarnessService {
    const childScript = `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const frame = JSON.parse(line);
        if (frame.type === "request") {
          process.stdout.write(JSON.stringify({
            type: "response",
            id: frame.id,
            ok: true,
            result: { echo: frame.body, scope: frame.scope, path: frame.path },
          }) + "\\n");
        } else if (frame.type === "stream:open") {
          process.stdout.write(JSON.stringify({ type: "stream:data", id: frame.id, data: "chunk-1" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "stream:data", id: frame.id, data: "chunk-2" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "stream:end", id: frame.id }) + "\\n");
        }
      });
    `;

    const service = new StdioHarnessService({
      meta: { harnessId: "stdio-worker", name: "Stdio Worker", kind: "worker" },
      command: process.execPath,
      args: ["--input-type=module", "-e", childScript],
    });
    disposables.push(() => service.dispose());
    return service;
  }

  test("routes RPC calls and streams across a spawned stdio child process", async () => {
    const service = createService();
    const registry = createHarnessRegistry();
    registry.register(service.toRegistration());

    const runtime = await registry.resolve("stdio-worker");
    const { signal } = new AbortController();
    const rpcResult = await runtime.handleCall(
      ["s1"],
      "ping",
      { hello: "world" },
      signal,
    );
    expect(rpcResult).toEqual({
      echo: { hello: "world" },
      scope: ["s1"],
      path: "/rpc/ping",
    });

    const chunks: unknown[] = [];
    for await (const chunk of runtime.handleStream(["s1"], "/events", null, signal)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["chunk-1", "chunk-2"]);
  });

  test("retires a resolved stdio runtime when its harness is unregistered", async () => {
    const service = createService();
    const registry = createHarnessRegistry();
    registry.register(service.toRegistration());
    const runtime = await registry.resolve("stdio-worker");
    const { signal } = new AbortController();

    const ping = () => runtime.handleCall([], "ping", null, signal);
    await expect(ping()).resolves.toEqual({ echo: null, scope: [], path: "/rpc/ping" });

    await registry.unregister("stdio-worker");

    const events = runtime.handleStream([], "/events", null, signal);
    await Promise.all([
      expect(service.resolveRuntime()).rejects.toThrow("Stdio harness disposed"),
      expect(ping()).rejects.toThrow("Stdio harness disposed"),
      expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("Stdio harness disposed"),
    ]);
  });
});
