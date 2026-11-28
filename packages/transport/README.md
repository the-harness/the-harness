```ts
// 可拓展接口：通过继承 Transport 接入底层通信传输（HTTP/WS/Memory）并支持作用域派生
abstract class Transport {
  abstract request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  abstract openStream(path: string, body?: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
  abstract childScope(id: string): Descriptor<Transport>; // 返回派生作用域的实现描述，供子 Scope provide
}

class ServerTransport {
  useCall(path: string, handler: CallHandler): void; // 在当前 EffectScope 中注册 call 处理函数
  useStream(path: string, handler: StreamHandler): void; // 在当前 EffectScope 中注册 stream 处理函数
  childScope(id: string): Descriptor<ServerTransport>; // 返回派生作用域的服务端路由描述，供子 Scope provide
}

class RootServerTransport extends ServerTransport {
  handleCall(scope: readonly string[], path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  handleStream(scope: readonly string[], path: string, body: unknown, signal: AbortSignal): AsyncIterable<unknown>;
}

class WebTransportConnection {} // 共享的 WebSocket 连接，随所在 Scope 关闭

class WebTransport extends Transport {
  constructor(scopePath?: readonly string[]);
}
```
