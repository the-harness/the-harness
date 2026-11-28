import type { Descriptor } from "@harness/di";

// 可拓展接口：通过继承 Transport 接入底层通信传输（HTTP/WS/Memory）并支持作用域派生
export abstract class Transport {
  abstract request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  abstract openStream(path: string, body?: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
  abstract childScope(id: string): Descriptor<Transport>;
}
