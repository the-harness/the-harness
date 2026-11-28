import { expect, it } from "vite-plus/test";
import { StdioHarnessService } from "../packages/harness-stdio/src/index.ts";

it("only opens live stdio streams and releases them when consumers stop iterating", async () => {
  const server = new URL("../packages/harness-stdio/src/server.ts", import.meta.url).href;
  const childScript = `
    import { serveStdioRuntime } from ${JSON.stringify(server)};
    const opened = [];
    const closed = [];
    serveStdioRuntime({
      rpcServer: {
        async handleCall() {
          return { opened, closed };
        },
      },
      streamServer: {
        async *handleStream(path, _scope, _body, signal) {
          opened.push(path);
          try {
            yield "event";
            if (path === "/watch" && !signal.aborted) {
              await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            }
          } finally {
            closed.push(path);
          }
        },
      },
    });
  `;
  const service = new StdioHarnessService({
    meta: { harnessId: "stream-worker", name: "Stream Worker", kind: "worker" },
    command: process.execPath,
    args: ["--input-type=module", "-e", childScript],
  });
  try {
    const { rpcServer, streamServer } = await service.resolveRuntime();
    const aborted = AbortSignal.abort();
    const chunks: unknown[] = [];
    for await (const chunk of serverTransport.handleStream([], "/canceled", null, aborted)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);

    const { signal } = new AbortController();
    for await (const chunk of serverTransport.handleStream([], "/watch", null, signal)) {
      chunks.push(chunk);
      break;
    }
    expect(chunks).toEqual(["event"]);
    await expect
      .poll(() => serverTransport.handleCall([], "lifecycle", null, signal))
      .toEqual({
        opened: ["/watch"],
        closed: ["/watch"],
      });
  } finally {
    service.dispose();
  }
});
