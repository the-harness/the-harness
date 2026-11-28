import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { QuickInputModal, UiQuickInputService } from "@harness/ui-quick-input";
import { createApp, h } from "vue";
import "../src/style.css";

const scope = createRootScope();
scope.provide(UiQuickInputService);
const quickInput = scope.get(UiQuickInputService);
const items = Array.from({ length: 20 }, (_, index) => ({
  label: `Candidate ${String(index + 1).padStart(2, "0")}`,
  description: `Description ${index + 1}`,
  detail: "Additional context for the selected candidate",
  picked: index === 0,
}));
let pending: Promise<unknown> | undefined;

export function showPick(multiple = false): void {
  const options = { title: "Choose a candidate" };
  pending = multiple
    ? quickInput.showQuickPickMany(items, options)
    : quickInput.showQuickPick(items, options);
}

export function mount(preselected = false): void {
  if (preselected) showPick(true);
  createApp({
    setup() {
      provideScope(scope);
      return () => [
        h("button", { onClick: () => showPick() }, "Open picker"),
        h("button", { onClick: () => showPick(true) }, "Open multiple picker"),
        h(QuickInputModal),
      ];
    },
  }).mount("#app");
}

export function result(): Promise<unknown> | undefined {
  return pending;
}
