import type { Scope } from "@harness/di";
import { TerminalService, type CreateTerminalOptions, type TerminalInfo } from "@harness/terminal";
import type { WebSocket } from "ws";

export function listTerminals(scope: Scope): TerminalInfo[] {
  return scope.get(TerminalService).list();
}

export async function createTerminal(
  scope: Scope,
  options?: CreateTerminalOptions,
): Promise<TerminalInfo> {
  return scope.get(TerminalService).create(options);
}

export function killTerminal(scope: Scope, id: string): boolean {
  return scope.get(TerminalService).kill(id);
}

export function writeTerminal(scope: Scope, id: string, data: string): boolean {
  const service = scope.get(TerminalService);
  const terminal = service.get(id);
  if (!terminal || terminal.exited) return false;
  service.write(id, data);
  return true;
}

export function attachTerminalSocket(scope: Scope, ws: WebSocket, id: string): void {
  if (ws.readyState !== ws.OPEN) return;

  const service = scope.get(TerminalService);
  const attachment = service.attach(id, {
    onData: (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    },
    onExit: (exitCode) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
      }
    },
    onClose: () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "removed" }));
    },
    onStateChange: (state) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "state", state }));
    },
    onResize: (cols, rows) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    },
  });

  if (!attachment) {
    ws.send(JSON.stringify({ type: "error", message: `Terminal not found: ${id}` }));
    ws.close(1008, "Terminal not found");
    return;
  }

  ws.once("close", attachment.detach);
  ws.send(
    JSON.stringify({
      type: "snapshot",
      info: attachment.snapshot.info,
      data: attachment.snapshot.data,
    }),
  );

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as
        | { type: "input"; data: string }
        | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input" && typeof msg.data === "string") {
        service.write(id, msg.data);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        service.resize(id, msg.cols, msg.rows);
      }
    } catch {
      // Ignore malformed client message
    }
  });
}
