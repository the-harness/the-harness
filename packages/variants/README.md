```ts
variant<Ctor extends VariantConstructor>(name: string): (target: Ctor) => void // 注册可序列化变体类标识（格式为 "<author>:<package>:<name>"）；热更新中同一模块重新注册同名时记为该类的新版本；其他模块尚未应用的注册同样占用该名称；模块更新应用时释放其不再注册的名称；尚未应用的注册仅对已插桩模块执行期间的代码可见（各模块最近一次未抛错的执行）

abstract class ExtensibleFields {
  static defineField<TValue, TThis extends abstract new (...args: any[]) => ExtensibleFields>(
    this: TThis,
    name: string,
  ): FieldKey<InstanceType<TThis>, TValue>; // 定义与当前容器绑定的隔离字段 Key（格式为 "<author>:<package>:<name>"）；热更新中同一模块重新定义时返回原 Key，新定义的名称随该更新一同应用或撤销，其他模块尚未应用的定义同样占用该名称；模块更新应用时释放其不再定义的名称
  static [Symbol.hasInstance](value: unknown): boolean; // 值的类链中含该类的任一版本即为实例（包括本模块热更新前的基类）
  static serialize(instance: ExtensibleFields): Record<string, unknown>;
  static deserialize<T extends ExtensibleFields>(this: FieldConstructor<T>, raw?: Record<string, unknown>): T;
  get<TValue>(key: FieldKey<this, TValue>): TValue | undefined;
  has<TValue>(key: FieldKey<this, TValue>): boolean;
  set<TValue>(key: FieldKey<this, TValue>, value: TValue): this;
  delete<TValue>(key: FieldKey<this, TValue>): boolean;
}

abstract class ExtensibleVariants<TDefaults extends object = {}> {
  static get schema<T extends ExtensibleVariants>(this: VariantConstructor<T>): z.ZodType<T>; // 获取用于校验该变体基类实例的 Zod schema
  static [Symbol.hasInstance](value: unknown): boolean; // 值的类链中含该类的任一版本或同名变体即为实例
  static create<T extends ExtensibleVariants<any>>(this: new (props?: any) => T, props: VariantProps<T>): T; // 按继承链属性类型创建该类最新版本的实例
  static getVariantChain(instance: ExtensibleVariants): readonly string[]; // 获取实例从基类到具体子类的变体名称链
  static serialize(instance: ExtensibleVariants): SerializedVariant; // 递归序列化变体及其嵌套变体并记录 $variants 继承链
  static deserialize<T extends ExtensibleVariants>(this: VariantConstructor<T>, raw: SerializedVariant): T; // 按 $variants 链从最具体子类向已知基类回退反序列化
}

interface SerializedVariant {
  readonly $variants: readonly string[];
  readonly [key: string]: unknown;
}
```
