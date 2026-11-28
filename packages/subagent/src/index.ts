import { CurrentScope, inject, type Scope, type ScopeOptions } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { shallowReactive } from "reactivity";

export interface AgentManagerHooks {
  readonly setup: HookSlot<void, void>;
}

export class AgentManager {
  readonly hooks: AgentManagerHooks = {
    setup: new HookSlot<void, void>(),
  };

  readonly agents: ReadonlyMap<string, Scope>;

  protected readonly currentScope = inject(CurrentScope);
  protected readonly agentMap = shallowReactive(new Map<string, Scope>());
  protected nextAgentIndex = 0;

  constructor() {
    this.agents = this.agentMap;
  }

  create(options: ScopeOptions = {}): Scope {
    const id = options.id ?? this.nextGeneratedId();
    if (this.agentMap.has(id)) {
      throw new Error(`agent '${id}' already exists`);
    }

    const child = this.currentScope.createChild({ id });
    child.setup(() => this.hooks.setup.run(undefined, () => {}));

    this.agentMap.set(id, child);
    child.onDispose(() => {
      if (this.agentMap.get(id) === child) {
        this.agentMap.delete(id);
      }
    });

    return child;
  }

  protected nextGeneratedId(): string {
    let id = `agent-${++this.nextAgentIndex}`;
    while (this.agentMap.has(id)) {
      id = `agent-${++this.nextAgentIndex}`;
    }
    return id;
  }
}
