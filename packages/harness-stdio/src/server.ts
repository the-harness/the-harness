import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RootServerTransport } from "@harness/transport";

interface ClientFrame {
  readonly type: string;
  readonly id: string;
  readonly scope?: readonly string[];
  readonly path?: string;
  readonly body?: unknown;
}

export function serveStdioRuntime(
  serverTransport: RootServerTransport,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): () => void {
  const activeStreams = new Map<string, AbortController>();

  const send = (frame: unknown) => {
    if (!output.writableEnded) {
      output.write(`${JSON.stringify(frame)}\n`);
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  const handleLine = async (line: string) => {
    if (!line.trim()) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(line) as ClientFrame;
    } catch {
      return;
    }

    if (frame.type === "request") {
      try {
        const route = (frame.path ?? "").replace(/^\/rpc\//, "");
        const result = await runtime.rpcServer.handleCall(route, frame.scope ?? [], frame.body);
        send({ type: "response", id: frame.id, ok: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "response", id: frame.id, ok: false, error: message });
      }
      return;
    }

    if (frame.type === "stream:open") {
      const ac = new AbortController();
      activeStreams.set(frame.id, ac);
      try {
        for await (const chunk of runtime.streamServer.handleStream(
          frame.path ?? "",
          frame.scope ?? [],
          frame.body,
          ac.signal,
        )) {
          if (ac.signal.aborted) break;
          send({ type: "stream:data", id: frame.id, data: chunk });
        }
        if (!ac.signal.aborted) {
          send({ type: "stream:end", id: frame.id });
        }
      } catch (error) {
        if (!ac.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: "stream:error", id: frame.id, error: message });
        }
      } finally {
        activeStreams.delete(frame.id);
      }
      return;
    }

    if (frame.type === "stream:close") {
      const ac = activeStreams.get(frame.id);
      if (ac) {
        ac.abort();
        activeStreams.delete(frame.id);
      }
    }
  };

  rl.on("line", handleLine);
  rl.once("close", () => {
    rl.off("line", handleLine);
    for (const ac of activeStreams.values()) {
      ac.abort();
    }
    activeStreams.clear();
  });

  return () => {
    rl.close();
  };
}
