```ts
// @harness/session-digest
class SessionDigest extends ExtensibleFields {
  hook<TValue>(key: FieldKey<SessionDigest, TValue>): HookSlot<void, TValue | undefined>; // 获取字段派生钩子，terminal 默认回退至基准值
}
```

```ts
// @harness/session-digest/node
interface SessionDigestStoreOptions {
  readonly onError?: (error: unknown) => void;
}

class SessionDigestStore {
  readonly digests: ReadonlyMap<string, SessionDigest>; // 内存常驻的 per-session 响应式摘要缓存，基值与派生值分离并合批落盘 SQLite
  constructor(options?: SessionDigestStoreOptions);
  get(sessionId: string): SessionDigest; // 获取指定会话的 SessionDigest 实例并纳入响应式持久化追踪
  delete(sessionId: string): boolean; // 删除指定会话的内存摘要与 SQLite 持久化记录
  flush(): Promise<void>; // 等待已受理的变更落盘
}

interface SessionDigestServiceOptions {
  readonly id: string;
}

class SessionDigestService {
  readonly id: string;
  readonly digest: SessionDigest;
  constructor(options: SessionDigestServiceOptions);
  get<TValue>(key: FieldKey<SessionDigest, TValue>): TValue | undefined;
  has<TValue>(key: FieldKey<SessionDigest, TValue>): boolean;
  set<TValue>(key: FieldKey<SessionDigest, TValue>, value: TValue): this;
  delete<TValue>(key: FieldKey<SessionDigest, TValue>): boolean;
  hook<TValue>(key: FieldKey<SessionDigest, TValue>): HookSlot<void, TValue | undefined>;
}
```
