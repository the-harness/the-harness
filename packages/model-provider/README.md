```ts
interface ProviderManagerHooks {
  readonly setup: HookSlot<void, void>; // 在每个新创建的 Provider Scope 的 setup 中执行
}

class ProviderManager {
  readonly hooks: ProviderManagerHooks;
  readonly providers: Map<string, Scope>; // 当前作用域下的所有 Provider 子 Scope（shallowReactive Map）
  create(options?: ScopeOptions): Scope; // 创建绑定 hooks.setup 的 Provider 子 Scope
}
```
