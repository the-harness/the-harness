```ts
plugin: Plugin // oxlint 插件，名称 harness

rules: {
  "no-module-state": Rule; // 模块顶层被重新赋值的 let/var、ref/shallowRef/reactive/shallowReactive 常量，或被修改的 Map/Set/WeakMap/WeakSet/数组/对象常量；使用 import.meta.hot 自行管理热更新的模块豁免
}
```
