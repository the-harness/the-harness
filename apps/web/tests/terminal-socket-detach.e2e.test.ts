import { once } from "node:events";
import { TerminalService } from "@harness/terminal";
import { expect, it, vi } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";
import { attachTerminalSocket } from "../src/server/terminal.ts";

it("does not subscribe a disconnected WebSocket to terminal output", async () => {
  const attach = vi.spyOn(TerminalService.prototype, "attach").mockReturnValue(undefined);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected a TCP address");

    const accepted = once(server, "connection") as Promise<[WebSocket]>;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminals/terminal-id`);
    const [[socket]] = await Promise.all([accepted, once(client, "open")]);
    const closed = once(socket, "close");
    client.close();
    await closed;

    attachTerminalSocket(socket, "terminal-id");

    expect(attach).not.toHaveBeenCalled();
  } finally {
    attach.mockRestore();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
