import type { ExtHostWireError } from "./wire-error.ts";

export interface RpcRequest {
  type: "request";
  id: number;
  method: string;
  args: unknown[];
}

export interface RpcResponse extends Partial<ExtHostWireError> {
  type: "response";
  id: number;
  result?: unknown;
  release?: { command: string; listId: number };
}

export interface RpcCancel {
  type: "cancel";
  id: number;
}

export interface RpcRelease {
  type: "release";
  command: string;
  listId: number;
}

export type IpcMessage = RpcRequest | RpcResponse | RpcCancel | RpcRelease;
