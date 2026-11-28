import { CurrentScope, inject, type Scope, type ScopeOptions } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { pauseTracking, resetTracking, shallowReactive } from "reactivity";

export interface ProviderManagerHooks {
  readonly setup: HookSlot<void, void>;
}

export class ProviderManager {
  readonly hooks: ProviderManagerHooks = {
    setup: new HookSlot<void, void>(),
  };

  readonly providers = shallowReactive(new Map<string, Scope>());

  protected readonly currentScope = inject(CurrentScope);
  protected nextProviderIndex = 0;

  create(options: ScopeOptions = {}): Scope {
    // Callers inside a setup must not re-run whenever another provider is added or removed.
    pauseTracking();
    try {
      return this.createUntracked(options);
    } finally {
      resetTracking();
    }
  }

  protected createUntracked(options: ScopeOptions): Scope {
    const id = options.id ?? this.nextGeneratedId();
    if (this.providers.has(id)) {
      throw new Error(`provider '${id}' already exists`);
    }

    const child = this.currentScope.createChild({ id });
    child.setup(() => this.hooks.setup.run(undefined, () => {}));

    this.providers.set(id, child);
    child.onDispose(() => {
      if (this.providers.get(id) === child) {
        this.providers.delete(id);
      }
    });

    return child;
  }

  protected nextGeneratedId(): string {
    let id = `provider-${++this.nextProviderIndex}`;
    while (this.providers.has(id)) {
      id = `provider-${++this.nextProviderIndex}`;
    }
    return id;
  }
}
