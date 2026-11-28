```ts
class HookSlot<TInput, TResult = void> {
  use(handler: HookHandler<TInput, TResult>, position?: HookPosition): HookAnchor; // 在当前 EffectScope 中注册处理函数，随 Scope 自动卸载
  run(
    input: TInput,
    ...args: [TResult] extends [void]
      ? [terminal?: HookTerminal<TInput, TResult>]
      : [terminal: HookTerminal<TInput, TResult>]
  ): TResult; // 按洋葱圈顺序执行处理函数并汇聚到 terminal
}

interface HookPosition {
  before?: HookAnchor;
  after?: HookAnchor;
}
```
