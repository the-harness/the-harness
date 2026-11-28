```ts
interface CommandMeta {
  readonly title?: string;
  readonly category?: string;
  readonly icon?: string;
}

interface CommandEntry {
  readonly id: string;
  readonly meta?: CommandMeta;
}

interface QuickAccessItem {
  id: string;
  title: string;
  icon: string;
  shortcut?: string;
  run: () => void;
  description?: string;
  searchText?: string; // Additional path text to match.
  prefix?: string; // Selecting this item switches mode without closing.
  preview?: () => void;
}

class UiCommandsService {
  readonly commands: ComputedRef<readonly CommandEntry[]>;
  useCommand(id: string, handler: (...args: any[]) => unknown, meta?: CommandMeta): void; // 在当前 EffectScope 中注册命令，随 Scope 自动注销
  execute<T = unknown>(id: string, ...args: any[]): Promise<T | undefined>;
  has(id: string): boolean;
}
```
