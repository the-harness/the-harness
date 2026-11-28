import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { QuickInputModal, UiQuickInputService } from "@harness/ui-quick-input";
import { createApp, h, watch } from "vue";

const scope = createRootScope();
scope.provide(UiQuickInputService);
const service = scope.get(UiQuickInputService);
let inputs: Promise<string | undefined>[] = [];

createApp({
  setup() {
    provideScope(scope);
    return () => h(QuickInputModal);
  },
}).mount("#app");

export function replaceInput(): (string | null)[] {
  const previous = service.showInputBox({ title: "Previous" });
  const observed: (string | null)[] = [];
  let nested: Promise<string | undefined> | undefined;
  const stop = watch(
    service.activeRequest,
    (request) => {
      const title = request?.options?.title ?? null;
      observed.push(title);
      if (title === "Replacement") {
        nested = service.showInputBox({ title: "Nested", value: "nested response" });
      }
    },
    { flush: "sync" },
  );
  const replacement = service.showInputBox({ title: "Replacement" });
  stop();
  if (!nested) throw new Error("Nested input was not published");
  inputs = [previous, replacement, nested];
  return observed;
}

export function disposeInput(): void {
  const previous = service.showInputBox({ title: "Closing" });
  let late: Promise<string | undefined> | undefined;
  const stop = watch(
    service.activeRequest,
    (request) => {
      if (request === null) late = service.showInputBox({ title: "Late request" });
    },
    { flush: "sync" },
  );
  scope.dispose();
  stop();
  if (!late) throw new Error("No attempt to open input during disposal");
  inputs = [previous, late];
}

export function results() {
  return Promise.all(inputs);
}

export function showMultiple() {
  return service
    .showQuickPickMany([{ label: "Alpha", picked: true }, { label: "Beta" }], {
      title: "Choose folders",
    })
    .then((items) => items?.map((item) => item.label));
}
