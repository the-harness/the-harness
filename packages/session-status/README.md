```ts
// @harness/session-status
abstract class SessionStatus extends ExtensibleVariants {
  abstract present(): SessionStatusView; // 返回默认 UI 展示视图
  recover(): SessionStatus | undefined; // 重启恢复时的状态转换
  acknowledge(): SessionStatus | undefined; // 用户已读确认时的状态转换
}

class UiSessionStatusService {
  readonly active: ComputedRef<ReadonlyMap<string, SessionStatus>>; // 只读同步状态表
  get(sessionId: string): SessionStatus | undefined;
  usePresenter<T extends SessionStatus>(
    ctor: VariantConstructor<T>,
    presenter: SessionStatusPresenter<T>,
  ): void; // 在当前 EffectScope 中注册展示器，随 Scope 自动注销
  present(sessionIdOrStatus: string | SessionStatus | undefined): SessionStatusView;
}
```

```ts
// @harness/session-status/node
class SessionStatusService {
  readonly hooks: SessionStatusHooks; // status 派生钩子（基于 SessionDigestService）
  readonly current: ComputedRef<SessionStatus | undefined>;
  set(status: SessionStatus | undefined): void;
}

class SessionStatusHostService {
  readonly active: SyncedRecordHost<SessionStatus>; // 后端单向同步宿主
}

function recoverSessionStatuses(): void; // 应用启动时恢复 SQLite 已载入的会话状态
function useSessionStatusHandlers(): void; // 把 SessionStatusHostService.active 注册为 SessionStatusStateSyncContract 的 server handler
```
