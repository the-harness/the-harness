import type { AbstractServiceConstructor, Scope } from "@harness/di";
import { inject as vueInject, provide, type InjectionKey } from "vue";

export const scopeKey: InjectionKey<Scope> = Symbol("harness.di.scope");

export function provideScope(scope: Scope): void {
  provide(scopeKey, scope);
}

export function useScope(): Scope {
  const scope = vueInject(scopeKey);
  if (scope === undefined) {
    throw new Error("DI Scope provider is missing");
  }
  return scope;
}

export function useService<T>(id: AbstractServiceConstructor<T>): T {
  return useScope().get(id);
}

export function useOptionalService<T>(id: AbstractServiceConstructor<T>): T | undefined {
  const scope = vueInject(scopeKey, undefined);
  if (scope === undefined) {
    return undefined;
  }
  return scope.getOptional(id);
}
