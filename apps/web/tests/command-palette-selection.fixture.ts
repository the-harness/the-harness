import type { Scope } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { scopeKey } from "@harness/ui-di";

const owners = new Map<string, Scope>();
const calls: string[] = [];

export function registerCommands(): void {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  const scope = app.__vue_app__._instance.provides[scopeKey]!;
  const commands = scope.get(UiCommandsService);
  for (const label of ["Alpha", "Beta", "Gamma"]) {
    const owner = scope.createChild();
    owners.set(label, owner);
    owner.run(() =>
      commands.useCommand(`test:palette:${label}`, () => calls.push(label), {
        title: `Scoped probe ${label}`,
      }),
    );
  }
}

export function retireCommand(label: string): void {
  owners.get(label)?.dispose();
}

export function invokedCommands(): readonly string[] {
  return calls;
}
