```ts
type SessionSetup = (sessionId: string) => void; // 在 session Scope 中执行；会话级服务经描述符静态参数获得 sessionId

class SessionManager {
  useSessionSetup(setup: SessionSetup): void; // 在当前 EffectScope 中注册；按注册顺序作为每个 session Scope 的 DI setup 执行（已有 Scope 随注册变化重跑，重新 provide 的服务保留实例）
  acquire(sessionId: string): Scope; // 获取或创建 session Scope；SessionCatalog 中的会话在加入目录时即创建
  get(sessionId: string): Scope | undefined;
  release(sessionId: string): void; // 释放并销毁 session Scope；会话从 SessionCatalog 删除时自动释放
}
```
