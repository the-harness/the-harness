```ts
provideScope(scope: Scope): void // 向 Vue 组件树提供 DI Scope
useScope(): Scope // 获取当前 Vue 组件树注入的 DI Scope
useService<T>(id: AbstractServiceConstructor<T>): T // 在 Vue setup 中获取当前 Scope 的服务实例
useOptionalService<T>(id: AbstractServiceConstructor<T>): T | undefined
```
