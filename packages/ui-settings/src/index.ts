import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";

export function useSettingsWorkbench(component: unknown): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.settings",
    panels: [
      {
        id: "settings",
        title: "Settings",
        icon: "i-codicon-settings-gear",
        component: component as never,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
