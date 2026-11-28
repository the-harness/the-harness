import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";

export function useContextWorkbench(component: unknown): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.context",
    panels: [
      {
        id: "context",
        title: "Context",
        icon: "i-codicon-symbol-namespace",
        component: component as never,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
