```ts
const ConfigStages: {
  readonly Defaults: unique symbol;
  readonly Preset: unique symbol;
  readonly User: unique symbol;
  readonly Workspace: unique symbol;
  readonly Session: unique symbol;
};

const DEFAULT_STAGE_ORDER: readonly symbol[];

class Config extends ExtensibleFields {} // 可拓展的配置容器，各模块通过 Config.defineField() 定义强类型 FieldKey

function createStorageConfigLayer(
  storage: UiStorageService,
  scope: readonly string[],
  storageKey: string,
): Config; // 创建接入 UiStorageService 与 CrossTabSync 的持久化 Config 层

class UiConfigService extends Config {
  constructor(stageOrder?: readonly symbol[]); // 默认使用 DEFAULT_STAGE_ORDER，子 DI Scope 默认继承父级顺序；根 Scope 自动挂载持久化 User 层
  useLayer(layer: Config, stage?: symbol): void; // 在当前 EffectScope 中挂载配置层，随 Scope 自动移除
  has<TValue>(key: FieldKey<this, TValue>): boolean;
  get<TValue>(key: FieldKey<this, TValue>): TValue | undefined; // 按 stageOrder 与 DI Scope 链懒解析并深度合并
}

function resolveConfiguration(
  snapshot: ConfigurationSnapshot,
  key: string,
  languageId?: string,
): unknown; // 浏览器与 worker 共用的分层解析
```
