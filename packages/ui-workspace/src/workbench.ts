import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import FilesPanel from "./panels/FilesPanel.vue";

export function useWorkspaceWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.workspace",
    panels: [
      {
        id: "files",
        title: "Files",
        icon: "i-codicon-files",
        component: FilesPanel,
        location: "right",
        presentation: "view",
      },
    ],
  });
}
