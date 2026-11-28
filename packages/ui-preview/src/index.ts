import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";

export function usePreviewWorkbench(component: unknown): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.preview",
    panels: [
      {
        id: "preview",
        title: "File preview",
        icon: "i-codicon-file-code",
        component: component as never,
        location: "within",
      },
    ],
  });
}
