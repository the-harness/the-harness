```ts
interface AgentManagerHooks {
  readonly setup: HookSlot<void, void>; // 在每个新创建的 Agent Scope 的 setup 中执行
}

class AgentManager {
  readonly hooks: AgentManagerHooks;
  readonly agents: ReadonlyMap<string, Scope>; // 当前作用域下的所有平权 Agent Scope
  create(options?: ScopeOptions): Scope; // 创建绑定 hooks.setup 的 Agent 子 Scope
}
```
