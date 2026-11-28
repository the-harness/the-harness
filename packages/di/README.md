```ts
inject<T>(id: AbstractServiceConstructor<T>): T // 在服务构造、createInstance 或 scope.run/setup 中同步获取服务实例并追踪依赖
optionalInject<T>(id: AbstractServiceConstructor<T>): T | undefined // 在服务构造、createInstance 或 scope.run/setup 中同步获取可选服务；服务未注册时返回 undefined，服务存在但构造失败时仍抛出
createDescriptor<Ctor extends ServiceConstructor<any>>(ctor: Ctor, ...staticArguments: ConstructorParameters<Ctor>): Descriptor<InstanceType<Ctor>>
createRootScope(options?: ScopeOptions): Scope // 创建独立根作用域，可创建多个
replaceService<T>(prevCtor: ServiceConstructor<T>, nextCtor: ServiceConstructor<T>): number // 将 nextCtor 记为 prevCtor 类族的最新版本，替换所有作用域中以该类族任一版本注册的实现，保留原静态参数并级联重算
useSetup(fn: () => void): void // 在运行中的 setup 内嵌套一个 setup：独立追踪依赖并单独重跑；外层重跑时随之重建，新一轮重新 provide 的服务保留原实例
defineSetup<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void // 定义一个 setup 单元：每次调用等价于 useSetup(() => fn(...args))；setup 之外调用报错；热更新时导出保持同一函数，只重跑用到改动代码的单元
useServices(entries: ServiceEntries): void // 在运行中的 setup 所在的 Scope 中 provideAll，服务归属该 setup

type ServiceEntry =
  | ServiceConstructor<any>
  | Descriptor<any>
  | readonly [ServiceIdentifier<any>, ServiceConstructor<any> | Descriptor<any>];

interface ScopeOptions {
  readonly id?: string;
}

class Scope {
  readonly id: string;
  readonly parent: Scope | undefined;
  readonly root: Scope; // 所属根作用域；root 自身返回 this
  readonly isRoot: boolean;
  readonly isDisposed: boolean;
  readonly children: Map<string, Scope>;
  get<T>(id: AbstractServiceConstructor<T>): T; // 读取当前作用域或其祖先中的顶层 Base Service 实例（支持响应式追踪）
  getOptional<T>(id: AbstractServiceConstructor<T>): T | undefined; // 同上，但服务未注册时返回 undefined
  run<T>(fn: () => T): T; // 在当前作用域的 EffectScope 与注入上下文中执行函数
  setup(fn: () => void): void; // 在受控子 EffectScope 中响应式执行 use* 绑定，依赖的服务或热更新的模块变化时自动清理重绑；其中 provide 的服务归属该 setup，重跑后未再 provide 的服务被移除
  onDispose(fn: () => void): void; // 注册随当前作用域停止而触发的清理回调
  createChild(options?: ScopeOptions): Scope; // 创建多级子作用域，继承祖先并按 DAG 构造自有服务
  createInstance<T>(descriptor: Descriptor<T>): T; // 服务标识取类族首个版本，构造取最新版本（provide 同理）
  createInstance<Ctor extends ServiceConstructor<any>>(ctor: Ctor, ...args: ConstructorParameters<Ctor>): InstanceType<Ctor>;
  provide<T>(ctorOrDescriptor: ServiceConstructor<T> | Descriptor<T>): void;
  provide<T>(id: AbstractServiceConstructor<T>, ctorOrDescriptor: ServiceConstructor<T> | Descriptor<T>): void; // 更新服务，清理受影响旧实例后沿 DAG 级联重算；构造器相同且静态参数为相等的纯数据时不做任何事
  provideAll(entries: ServiceEntries): void;
  unprovide<T>(id: AbstractServiceConstructor<T>): void; // 移除服务并执行其清理（若仍被强依赖则报错）
  dispose(): void; // 逆序释放子作用域、setup 绑定、服务清理钩子及 EffectScope
}

abstract class CurrentScope {
  abstract readonly id: string;
  abstract createChild(options?: ScopeOptions): Scope; // 供服务在当前作用域下创建子作用域，不暴露当前作用域的 get/provide/dispose
}

abstract class InstantiationService {
  abstract createInstance<T>(descriptor: Descriptor<T>): T;
  abstract createInstance<Ctor extends ServiceConstructor<any>>(ctor: Ctor, ...args: ConstructorParameters<Ctor>): InstanceType<Ctor>;
}
```

```ts
// @harness/di/vite
DiHmrPlugin(options: DiHmrPluginOptions): Plugin // 热更新：模块重新执行时经 replaceService 重建其类，并只重新执行以 inject/createDescriptor/useService 之外方式使用这些类的导入方；服务端环境的导出函数经稳定转发器指向最新实现，客户端环境的导出函数与其余导出一样在变化时只重新执行用到变化导出名的导入方（及未记录依赖的导入方，如 Vue 组件）；会重新执行热更新运行时（@harness/di、@harness/hot）的更新改为整体重载

interface DiHmrPluginOptions {
  readonly include: (id: string) => boolean; // 需要插桩的模块（必填）；持有其他模块依赖的状态的模块（如注册表）不应包含，使其更新改为重新执行导入方
}
```
