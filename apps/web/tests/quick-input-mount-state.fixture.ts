import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { QuickInputModal, UiQuickInputService } from "@harness/ui-quick-input";
import { createApp, h, type App } from "vue";

const scope = createRootScope();
scope.provide(UiQuickInputService);
const quickInput = scope.get(UiQuickInputService);
const inputs = new Map<string, Promise<string | undefined>>();
let modal: App | undefined;

export function mountModal(): void {
  modal = createApp({
    setup() {
      provideScope(scope);
      return () => h(QuickInputModal);
    },
  });
  modal.mount("#app");
}

export function unmountModal(): void {
  modal?.unmount();
  modal = undefined;
}

export function showInput(title: string, value: string): void {
  inputs.set(title, quickInput.showInputBox({ title, value }));
}

export function inputResult(title: string): Promise<string | undefined> {
  const result = inputs.get(title);
  if (!result) throw new Error(`Missing input request: ${title}`);
  return result;
}
