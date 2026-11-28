import { CurrentScope, inject, type Scope } from "@harness/di";
import { SessionCatalog } from "@harness/session-catalog";
import { getCurrentScope, onScopeDispose, shallowReactive } from "reactivity";

export type SessionSetup = (sessionId: string) => void;

// One runtime scope per session; every session in the catalog has one.
export class SessionManager {
  private readonly currentScope = inject(CurrentScope);
  private readonly sessions = new Map<string, Scope>();
  private readonly setups = shallowReactive(new Set<SessionSetup>());

  constructor() {
    const catalog = inject(SessionCatalog);
    onScopeDispose(catalog.onCreate((id) => this.acquire(id)));
    onScopeDispose(catalog.onRemove((id) => this.release(id)));
    for (const { id } of catalog.items) this.acquire(id);
    onScopeDispose(() => {
      for (const scope of this.sessions.values()) scope.dispose();
      this.sessions.clear();
    });
  }

  // Runs in every session scope as a DI setup, in registration order, until the caller's scope stops.
  useSessionSetup(setup: SessionSetup): void {
    if (getCurrentScope() === undefined) {
      throw new Error("useSessionSetup() requires an active EffectScope");
    }
    this.setups.add(setup);
    onScopeDispose(() => this.setups.delete(setup));
  }

  acquire(sessionId: string): Scope {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const scope = this.currentScope.createChild({ id: `session:${sessionId}` });
    this.sessions.set(sessionId, scope);
    try {
      scope.setup(() => {
        for (const setup of this.setups) setup(sessionId);
      });
    } catch (error) {
      this.release(sessionId);
      throw error;
    }
    return scope;
  }

  get(sessionId: string): Scope | undefined {
    return this.sessions.get(sessionId);
  }

  release(sessionId: string): void {
    const scope = this.sessions.get(sessionId);
    if (!scope) return;
    this.sessions.delete(sessionId);
    scope.dispose();
  }
}
