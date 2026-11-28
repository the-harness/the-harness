import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import OutputPanel from "./panels/OutputPanel.vue";

export function useOutputWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.output",
    panels: [
      {
        id: "output",
        title: "Output",
        icon: "i-codicon-output",
        component: OutputPanel,
        location: "below",
        presentation: "view",
      },
    ],
  });
}
