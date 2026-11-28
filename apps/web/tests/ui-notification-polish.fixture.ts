import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { NotificationCenter, UiNotificationService } from "@harness/ui-notifications";
import { createApp, h } from "vue";
import "../src/style.css";

const scope = createRootScope();
scope.provide(UiNotificationService);
const notifications = scope.get(UiNotificationService);
let pending: Promise<number | undefined> | undefined;

createApp({
  setup() {
    provideScope(scope);
    return () => h(NotificationCenter);
  },
}).mount("#app");

export function show(actions: string[], cancelAction?: number): void {
  pending = notifications.showMessage({
    message: "Save changes?",
    detail: "Choose how to handle the current changes.",
    severity: "warning",
    modal: true,
    actions,
    cancelAction,
  });
}

export function result(): Promise<number | undefined> | undefined {
  return pending;
}

export function showNotifications(): void {
  pending = notifications.showMessage({
    message: "A file changed", detail: "Review the updated file.",
    severity: "info", actions: ["Review"],
  });
  notifications.notify("Workspace refreshed", 0);
}

export function clearNotifications(): void {
  for (const prompt of notifications.prompts.value) prompt.finish();
  notifications.dismiss();
}
