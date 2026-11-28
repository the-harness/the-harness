import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import ChangesPanel from "./ChangesPanel.vue";

export function useScmWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.scm",
    panels: [
      {
        id: "changes",
        title: "Changes",
        icon: "i-codicon-source-control",
        component: ChangesPanel,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
