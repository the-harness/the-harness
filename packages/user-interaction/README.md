# @harness/user-interaction

```ts
// 可拓展基类：所有需要人类介入的挂起请求
abstract class InteractionRequest extends ExtensibleVariants {}

class UserInputInteraction extends InteractionRequest {
  readonly callId?: string;
  readonly questions: readonly UserInputQuestion[];
}

class UiInteractionService {
  readonly active: ComputedRef<ReadonlyMap<string, readonly InteractionEntry[]>>; // 按 sessionId 聚合的只读同步表
  get(sessionId: string): readonly InteractionEntry[];
  resolve(interactionId: string, result: InteractionResult): Promise<void>;
}

class SessionInteractionService {
  readonly pending: ComputedRef<readonly InteractionEntry[]>;
  request<TRes = unknown>(
    req: InteractionRequest,
    options?: { signal?: AbortSignal }
  ): Promise<InteractionResult<TRes>>;
  resolve(id: string, result: InteractionResult): void;
}

class InteractionHostService {
  readonly active: SyncedRecordHost<readonly InteractionEntry[]>;
}
```
