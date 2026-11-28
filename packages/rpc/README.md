```ts
class RpcClientService {
  use<T extends RpcEndpoints>(contract: RpcContract<T>): RpcClient<T>; // 在当前 EffectScope 中获取按 contract 共享的客户端（引用计数），最后一个使用方的 Scope 结束时释放并中止未完成的请求
}

class RpcServerService {
  useHandlers<T extends RpcEndpoints>(contract: RpcContract<T>, handlers: RpcHandlers<T>): void; // 在当前 EffectScope 中注册到所在 DI Scope 的 ServerTransport，Scope 结束时注销
}
```
