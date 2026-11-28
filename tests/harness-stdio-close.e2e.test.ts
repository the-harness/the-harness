import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vite-plus/test";
import { serveStdioRuntime } from "../packages/harness-stdio/src/index.ts";

it("does not dispatch stdio frames still buffered when the runtime closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: string[] = [];
  const streams: string[] = [];
  const stop = serveStdioRuntime(
    {
      rpcServer: {
        async handleCall(route) {
          requests.push(route);
          if (route === "accepted") stop();
          return route;
        },
      },
      streamServer: {
        async *handleStream(path) {
          streams.push(path);
          yield path;
        },
      },
    },
    input,
    output,
  );

  try {
    const frames = [
      { type: "request", id: "1", path: "/rpc/accepted" },
      { type: "request", id: "2", path: "/rpc/buffered" },
      { type: "stream:open", id: "3", path: "/buffered" },
    ];
    const response = once(output, "data");
    input.end(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));

    const [reply] = await response;
    expect(JSON.parse(String(reply))).toEqual({
      type: "response",
      id: "1",
      ok: true,
      result: "accepted",
    });
    expect(requests).toEqual(["accepted"]);
    expect(streams).toEqual([]);
  } finally {
    stop();
    input.destroy();
    output.destroy();
  }
});
