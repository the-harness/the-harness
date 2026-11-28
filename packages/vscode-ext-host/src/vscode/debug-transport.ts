import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  DebugAdapterExecutable,
  DebugAdapterInlineImplementation,
  DebugAdapterNamedPipeServer,
  DebugAdapterServer,
} from "@harness/vscode-types";

export type DebugDescriptor =
  | DebugAdapterExecutable
  | DebugAdapterInlineImplementation
  | DebugAdapterNamedPipeServer
  | DebugAdapterServer;
export type DebugMessage = {
  seq: number;
  type: string;
  command?: string;
  arguments?: Record<string, unknown>;
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  body?: Record<string, any>;
};

export async function connectDebugAdapter(
  descriptor: DebugDescriptor,
  received: (message: DebugMessage) => void,
  sending: (message: DebugMessage) => void,
  closed: (error?: Error) => void,
) {
  let sequence = 0;
  let disposed = false;
  let write: (data: DebugMessage) => void;
  let cleanup: () => void;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, any>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const accept = (message: DebugMessage) => {
    received(message);
    if (message.type !== "response") return;
    const request = pending.get(message.request_seq!);
    if (!request) return;
    pending.delete(message.request_seq!);
    clearTimeout(request.timer);
    if (message.success === false)
      request.reject(new Error(message.message ?? `Debug request failed: ${message.command}`));
    else request.resolve(message.body ?? {});
  };
  const end = (error?: Error) => {
    if (disposed) return;
    disposed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error ?? new Error("Debug adapter connection closed"));
    }
    pending.clear();
    cleanup?.();
    closed(error);
  };
  if (descriptor instanceof DebugAdapterInlineImplementation) {
    const subscription = descriptor.implementation.onDidSendMessage((message) =>
      accept(message as DebugMessage),
    );
    write = (message) => descriptor.implementation.handleMessage(message);
    cleanup = () => {
      subscription.dispose();
      descriptor.implementation.dispose();
    };
  } else {
    let input: NodeJS.ReadableStream;
    let output: NodeJS.WritableStream;
    if (descriptor instanceof DebugAdapterExecutable) {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(descriptor.options?.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      const child = spawn(descriptor.command, descriptor.args, {
        cwd: descriptor.options?.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (data) => console.error(String(data)));
      child.on("error", end);
      child.on("exit", () => end());
      input = child.stdout;
      output = child.stdin;
      cleanup = () => {
        child.kill();
      };
    } else if (
      descriptor instanceof DebugAdapterServer ||
      descriptor instanceof DebugAdapterNamedPipeServer
    ) {
      const socket =
        descriptor instanceof DebugAdapterServer
          ? createConnection({ host: descriptor.host ?? "127.0.0.1", port: descriptor.port })
          : createConnection(descriptor.path);
      cleanup = () => {
        socket.destroy();
      };
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.on("error", end);
      socket.on("close", () => end());
      input = socket;
      output = socket;
    } else throw new Error("Unsupported debug adapter descriptor");
    let buffer = Buffer.alloc(0);
    input.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const length = Number(
          /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1],
        );
        if (!Number.isInteger(length) || length < 0 || length > 64 * 1024 * 1024) {
          end(new Error("Invalid debug protocol content length"));
          return;
        }
        if (buffer.length < headerEnd + 4 + length) return;
        const content = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
        buffer = buffer.subarray(headerEnd + 4 + length);
        try {
          accept(JSON.parse(content.toString("utf8")) as DebugMessage);
        } catch (error) {
          end(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    write = (message) => {
      const data = JSON.stringify(message);
      output.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
    };
  }
  const send = (message: Omit<DebugMessage, "seq">) => {
    if (disposed) throw new Error("Debug adapter connection is closed");
    const value = { ...message, seq: ++sequence };
    sending(value);
    write(value);
    return value.seq;
  };
  return {
    request(command: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const seq = sequence + 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`Debug request timed out: ${command}`));
        }, 15_000);
        pending.set(seq, { resolve, reject, timer });
        try {
          send({ type: "request", command, arguments: args });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(seq);
          reject(error);
        }
      });
    },
    respond(request: DebugMessage, body?: Record<string, unknown>, error?: string) {
      send({
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: !error,
        body,
        message: error,
      });
    },
    dispose() {
      end();
    },
  };
}
