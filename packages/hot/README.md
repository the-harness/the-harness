```ts
relateClassVersions(prev: Function, next: Function): void // 记录 next 与 prev 属于同一类族（不改变最新版本）
registerClassVersion(prev: Function, next: Function): void // 记录 next 为 prev 所在类族的最新版本
canonicalClass<T extends Function>(ctor: T): T // 类族的首个版本，用作稳定身份
latestClass<T extends Function>(ctor: T): T // 类族已应用的最新版本，用于构造；从未被应用的版本也解析到它
beginModuleEvaluation(id: string, update?: boolean): void // 热更新插桩在模块体开始执行时调用；update 为 true 时开始暂存注册表副作用
endModuleEvaluation(id: string): void
currentModuleEvaluation(): ModuleEvaluation | undefined // 当前正在执行的已插桩模块体；每次执行是不同的对象，可用于区分同一模块的不同次执行
isLiveModuleEvaluation(evaluation: ModuleEvaluation): boolean // 是否为其模块最近一次执行且未抛错
applyWithModuleUpdate(apply: () => () => void): void // 立即执行 apply；若正在执行热更新，则暂存到该更新被应用时再执行（apply 返回撤销函数）
registerModuleUpdateEffect(key: string, effect: (evaluation: ModuleEvaluation) => () => void): void // 为每次暂存副作用的模块执行追加 effect，随其他副作用一同应用或撤销（返回撤销函数）；同一 key 后注册者替换前者
takeModuleUpdateEffects(id: string): Array<() => () => void> // 取出模块本次执行暂存的副作用（含 registerModuleUpdateEffect 追加的）

interface ModuleEvaluation {
  readonly module: string; // 模块 id
}
```
