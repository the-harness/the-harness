import type { Scope } from "@harness/di";
import { scopeKey } from "@harness/ui-di";
import { UiSessionsService } from "@harness/ui-sessions";

function sessions(): UiSessionsService {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  return app.__vue_app__._instance.provides[scopeKey]!.get(UiSessionsService);
}

export function currentSessionId(): string {
  return sessions().current.value!.id;
}

export function selectSession(id: string): void {
  sessions().activeId.value = id;
}
