import { computed, getCurrentScope, onScopeDispose, reactive, type ComputedRef } from "vue";

export interface StatusBarItem {
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

export class UiStatusBarService {
  private readonly items = reactive(new Map<string, StatusBarItem>());
  private counter = 0;
  private disposed = false;

  readonly leftItems: ComputedRef<readonly StatusBarItem[]> = computed(() =>
    Array.from(this.items.values())
      .filter((item) => item.visible && item.alignment === "left")
      .sort((a, b) => b.priority - a.priority),
  );

  readonly rightItems: ComputedRef<readonly StatusBarItem[]> = computed(() =>
    Array.from(this.items.values())
      .filter((item) => item.visible && item.alignment === "right")
      .sort((a, b) => b.priority - a.priority),
  );

  constructor() {
    onScopeDispose(() => {
      this.disposed = true;
      this.items.clear();
    });
  }

  useItem(options?: {
    id?: string;
    alignment?: "left" | "right";
    priority?: number;
  }): StatusBarItem {
    if (this.disposed) throw new Error("UiStatusBarService is disposed");
    if (!getCurrentScope()?.active) {
      throw new Error("useItem() requires an active EffectScope");
    }
    const id = options?.id ?? `status-${++this.counter}`;
    if (this.items.has(id)) {
      throw new Error(`Status bar item '${id}' already exists`);
    }
    const item = reactive<StatusBarItem>({
      id,
      text: "",
      alignment: options?.alignment ?? "left",
      priority: options?.priority ?? 0,
      visible: false,
    });
    onScopeDispose(() => {
      if (this.items.get(id) === item) {
        this.items.delete(id);
      }
    });
    this.items.set(id, item);
    return item;
  }
}
