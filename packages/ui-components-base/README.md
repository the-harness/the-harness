```ts
export { ActionMenu, ContextMenu, Menu, MenuGroup, MenuItem, MenuAction, MenuSubmenu, type ResolvedMenuGroup } from "@harness/ui-menu"; // 共享菜单组件和数据类型
const Button: Component<{ variant?: "primary" | "secondary" | "text"; type?: "button" | "submit" | "reset"; disabled?: boolean }>
const IconButton: Component<{ icon: string; label: string; active?: boolean }>
const Pane: Component<{ title: string; count?: number; open?: boolean }>
const SelectBox: Component<{ options: readonly SelectOption[]; ariaLabel?: string; modelValue: string }>
const Switch: Component<{ label?: string; ariaLabel?: string; disabled?: boolean; modelValue: boolean }>
```
