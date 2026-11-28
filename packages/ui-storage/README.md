```ts
// 可拓展接口：通过继承 StorageSync 扩展同步或存储策略
abstract class StorageSync {
  abstract connect<TValue>(context: StorageSyncContext<TValue>): Ref<TValue>;
  delete?(key: string, storage: UiStorageService): void;
  clearScope?(prefix: string, storage: UiStorageService): void;
}

class EphemeralSync extends StorageSync {} // 纯内存
class TabSync extends StorageSync {
  constructor(options?: WebStorageSyncOptions);
} // sessionStorage
class LocalSync extends StorageSync {
  constructor(options?: WebStorageSyncOptions);
} // localStorage（不监听跨标签变化）
class CrossTabSync extends StorageSync {
  constructor(options?: WebStorageSyncOptions);
} // localStorage（跨标签实时同步）

class UiStorageService {
  readonly prefix: string;
  readonly localStorage: StorageLike;
  readonly sessionStorage: StorageLike;
  constructor(options?: UiStorageServiceOptions);
  scope(...segments: string[]): UiStorageService; // 派生子作用域存储实例
  use<TFields extends StorageFields>(
    namespace: string,
    fields: TFields,
    sync?: StorageSync,
  ): StorageState<TFields>; // 按命名空间声明一组同一 sync 方式的响应式状态（默认 LocalSync）
  delete(namespace: string): void;
  clear(): void;
}
```
