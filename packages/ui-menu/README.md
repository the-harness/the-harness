```ts
class Menu<C = void, G extends string = string> {
  constructor(definitions: Record<G, HookTerminal<C, readonly MenuItem[]>>); // 键为组 id，按对象键顺序创建默认组；各回调定义组内默认项
  readonly groups: Readonly<Record<G, MenuGroup<C>>>; // 稳定的组 handle；保留具体键名类型，映射不可替换
  use(handler: HookHandler<C, readonly MenuGroup<C>[]>, position?: HookPosition): HookAnchor; // 只处理组；注册需要 active EffectScope，随 scope 清理
  resolve(context: C): readonly ResolvedMenuGroup[]; // 在 computed 中解析；子菜单沿用 context；过滤隐藏项、未知变体和空组
}

class MenuGroup<C = void> {
  constructor(id: string, defaults?: HookTerminal<C, readonly MenuItem[]>); // 创建独立组后通过 Menu.use() 加入菜单；移出菜单不销毁组及其贡献
  readonly id: string;
  use(handler: HookHandler<C, readonly MenuItem[]>, position?: HookPosition): HookAnchor; // 只处理组内元素；next() 包含内置项，注册随 EffectScope 清理
  resolve(context: C): readonly MenuItem[]; // 同步运行组内 hook，构造时的默认项作为 next() 的终点
}

abstract class MenuItem extends ExtensibleVariants { // 可扩展变体基类；内置子类的扩展沿用原有交互；其他变体暂不渲染；菜单实例不用于序列化
  readonly id: string; // 组内唯一，动作路径包含组 id
  readonly label: string; // 显示文字，同时用于键盘搜索和无障碍
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly visible?: boolean;
}
class MenuAction extends MenuItem {
  constructor(props: VariantProps<MenuAction> & Pick<MenuAction, "run">); // 用构造器传入动作闭包；VariantProps 本身不包含函数
  readonly type?: "action" | "checkbox" | "radio";
  readonly shortcut?: string;
  readonly checked?: boolean; // 由调用方控制，run 更新业务状态
  readonly danger?: boolean;
  readonly run: () => void | Promise<void>; // 关闭并恢复焦点后执行；关闭期间被移除、禁用或替换的动作不会执行
}
class MenuSubmenu<C = void> extends MenuItem {
  constructor(props: VariantProps<MenuSubmenu<C>>);
  readonly menu: Menu<C>; // 使用同样的组和组内 hook
}
interface ResolvedMenuGroup {
  readonly id: string;
  readonly items: readonly ResolvedMenuItem[]; // 非空；组件只在组之间生成分隔线
}
interface ResolvedMenuItem {
  readonly item: MenuItem; // 保留原始变体实例
  readonly groups?: readonly ResolvedMenuGroup[]; // 子菜单的已解析组
}

const ActionMenu: Component<{
  groups: readonly ResolvedMenuGroup[];
  label: string;
  open?: boolean; // v-model:open
  restoreFocus?: boolean; // 默认 true
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  onError?: (error: unknown) => void; // 默认 reportError
}>; // 默认 slot 为按钮内容

const ContextMenu: Component<{
  groups: readonly ResolvedMenuGroup[];
  label: string;
  open?: boolean; // v-model:open
  restoreFocus?: boolean; // 默认 true
  onError?: (error: unknown) => void; // 默认 reportError
}>; // 可选默认 slot 为单个触发元素，支持右键、长按、Shift+F10 和 ContextMenu 键

interface ContextMenuHandle {
  show(anchor: MouseEvent | HTMLElement, returnFocus?: HTMLElement): void; // 元素锚点采用键盘焦点，鼠标事件采用指针坐标；空菜单不拦截原生菜单
  close(): void;
}
```
