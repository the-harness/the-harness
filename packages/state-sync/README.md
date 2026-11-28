```ts
class StateSyncClientService {
  use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T>; // 在当前 EffectScope 中获取按 contract 共享的客户端（引用计数），最后一个使用方的 Scope 结束时释放（含同步流）
}

class StateSyncServerService {
  useHandlers<T extends StateSyncEndpoints>(contract: StateSyncContract<T>, hosts: StateSyncHosts<T>): void; // 在当前 EffectScope 中注册各端点的宿主解析函数，Scope 结束时关闭该注册的同步流
}

// 可拓展接口：实现自定义同步数据结构的服务端宿主
interface StateSyncHost<TSnapshot = unknown, TFrame = unknown, TPatch = unknown> {
  snapshot(): TSnapshot;
  subscribe(listener: (frame: TFrame) => void): () => void;
  apply?(patch: TPatch): unknown;
}

// 可拓展接口：实现自定义同步端点并接入 StateSyncContract
interface StateSyncEndpoint<
  TClient = unknown,
  THost extends StateSyncHost<any, any, any> = StateSyncHost<any, any, any>,
  TPatch = unknown,
  TReadonly extends boolean = boolean,
> {
  readonly kind: string;
  readonly readonly: TReadonly;
  createClient(transport: Transport, paths: StateSyncClientPaths): TClient; // 在活动 EffectScope 中调用，Scope 停止时须释放资源
}

const stateSync: {
  array<T extends z.ZodTypeAny, R extends boolean = false>(item: T, options?: StateSyncArrayEndpointOptions<z.infer<T>, R>): StateSyncArrayEndpoint<T, R>; // 有序数组同步端点
  value<T extends z.ZodTypeAny, R extends boolean = false>(schema: T, options?: StateSyncEndpointOptions<R>): StateSyncValueEndpoint<T, R>; // 单值同步端点
  record<T extends z.ZodTypeAny, R extends boolean = false>(value: T, options?: StateSyncEndpointOptions<R>): StateSyncRecordEndpoint<T, R>; // 稀疏键值表同步端点
};
```
