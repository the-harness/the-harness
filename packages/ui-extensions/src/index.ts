import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";

export function useExtensionsWorkbench(component: unknown): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.extensions",
    panels: [
      {
        id: "extensions",
        title: "Extensions",
        icon: "i-codicon-extensions",
        component: component as never,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
