```ts
interface StatusBarItem {
  readonly id: string;
  name?: string;
  text: string;
  tooltip?: string | { markdown: string };
  color?: string;
  background?: "warning" | "error";
  accessibilityInformation?: { label: string; role?: string };
  command?: string;
  alignment: "left" | "right";
  priority: number;
  visible: boolean;
}

class UiStatusBarService {
  readonly leftItems: ComputedRef<readonly StatusBarItem[]>;
  readonly rightItems: ComputedRef<readonly StatusBarItem[]>;
  useItem(options?: {
    id?: string;
    alignment?: "left" | "right";
    priority?: number;
  }): StatusBarItem; // 在当前 EffectScope 中创建条目，随 Scope 自动移除
}
```
