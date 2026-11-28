import { computed, getCurrentScope, onScopeDispose, reactive, type ComputedRef } from "vue";

export interface CommandMeta {
  readonly title?: string;
  readonly category?: string;
  readonly icon?: string;
}

export interface CommandEntry {
  readonly id: string;
  readonly meta?: CommandMeta;
}

interface RegisteredCommand {
  readonly id: string;
  readonly handler: (...args: any[]) => unknown;
  readonly meta?: CommandMeta;
}

export class UiCommandsService {
  private readonly registry = reactive(new Map<string, RegisteredCommand>());

  readonly commands: ComputedRef<readonly CommandEntry[]> = computed(() =>
    Array.from(this.registry.values()).map(({ id, meta }) => ({ id, meta })),
  );

  constructor() {
    onScopeDispose(() => {
      this.registry.clear();
    });
  }

  useCommand(id: string, handler: (...args: any[]) => unknown, meta?: CommandMeta): void {
    if (!getCurrentScope()) {
      throw new Error("useCommand() requires an active EffectScope");
    }
    if (this.registry.has(id)) {
      throw new Error(`Command '${id}' is already registered`);
    }
    this.registry.set(id, { id, handler, meta });
    onScopeDispose(() => {
      this.registry.delete(id);
    });
  }

  async execute<T = unknown>(id: string, ...args: any[]): Promise<T | undefined> {
    const entry = this.registry.get(id);
    if (!entry) return undefined;
    return (await entry.handler(...args)) as T;
  }

  has(id: string): boolean {
    return this.registry.has(id);
  }
}

export { default as CommandPalette } from "./components/CommandPalette.vue";

export type { QuickAccessItem } from "./quickAccess.ts";
