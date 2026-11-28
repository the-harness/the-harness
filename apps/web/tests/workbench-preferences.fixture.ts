import { createWorkbench } from "@harness/ui-workbench";
import { nextTick } from "vue";

let workbench: ReturnType<typeof createWorkbench> | undefined;
const delayed: StorageEvent[] = [];

function getWorkbench() {
  return (workbench ??= createWorkbench());
}

function delayPreferenceChange(event: StorageEvent): void {
  if (!event.isTrusted || !event.key?.startsWith("harness:core:ui-workbench")) return;
  event.stopImmediatePropagation();
  delayed.push(event);
}

export function delayPreferenceChanges(): void {
  window.addEventListener("storage", delayPreferenceChange, true);
}

export function delayedChangeCount(): number {
  return delayed.length;
}

export function releasePreferenceChanges(): void {
  window.removeEventListener("storage", delayPreferenceChange, true);
  for (const event of delayed.splice(0)) {
    window.dispatchEvent(new StorageEvent("storage", event));
  }
}

export function readPreferences() {
  const workbench = getWorkbench();
  return { theme: workbench.theme.value, sidebarLocation: workbench.sidebarLocation.value };
}

export async function setTheme(theme: "dark" | "light"): Promise<void> {
  getWorkbench().theme.value = theme;
  await nextTick();
}

export async function setSidebarLocation(side: "left" | "right"): Promise<void> {
  getWorkbench().setSidebarPosition(side);
  await nextTick();
}
