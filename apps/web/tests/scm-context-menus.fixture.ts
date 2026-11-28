import type { Scope } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { scopeKey } from "@harness/ui-di";
import { UiScmService, type ScmProvider } from "@harness/ui-scm";
import { MenuAction } from "@harness/ui-menu";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { shallowRef } from "vue";

const providers = shallowRef<ScmProvider[]>([]);
const opened: string[] = [];

export function install(): void {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  const scope = app.__vue_app__._instance.provides[scopeKey]!;
  providers.value = ["First", "Second"].map((name) => ({
    handle: name, label: `${name} Repository`, inputValue: "",
    groups: new Map([["changes", { label: "Changes", resources: [{
      resourceUri: { scheme: "fixture", path: "/file.txt", fsPath: "/file.txt", toString: () => "fixture:/file.txt" },
      command: { command: `fixture.open.${name}` },
    }] }]]),
  }));
  scope.get(UiScmService).registerProviderSource(() => providers.value);
  scope.run(() => {
    for (const provider of providers.value) {
      scope.get(UiCommandsService).useCommand(`fixture.open.${provider.handle}`, () => { opened.push(String(provider.handle)); });
    }
  });
  scope.get(UiWorkbenchService).open("changes");
}

export function calls() { return opened; }
export function removeSecond() { providers.value = providers.value.slice(0, 1); }

export function overrideResourceMenu(): void {
  const app = document.querySelector("#app") as Element & {
    __vue_app__: { _instance: { provides: Record<symbol, Scope> } };
  };
  const scope = app.__vue_app__._instance.provides[scopeKey]!;
  scope.run(() => scope.get(UiScmService).menu.groups.resource.use(() => [
    new MenuAction({ id: "override", label: "Extension Action", run: () => { opened.push("Override"); } }),
  ]));
}

export function replaceSecond(): void {
  const second = providers.value[1]!;
  providers.value = [providers.value[0]!, { ...second }];
}
