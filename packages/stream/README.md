```ts
class StreamClientService {
  use<T extends StreamEndpoints>(contract: StreamContract<T>): StreamClient<T>; // 在当前 EffectScope 中获取按 contract 共享的客户端（引用计数），最后一个使用方的 Scope 结束时释放并中止未完成的请求
}

class StreamServerService {
  useHandlers<T extends StreamEndpoints>(contract: StreamContract<T>, handlers: StreamHandlers<T>): void; // 在当前 EffectScope 中注册到所在 DI Scope 的 ServerTransport，Scope 结束时注销
}
```
