// @unocss-include
import { inject } from "@harness/di";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { openWorkspaceTab, UiWorkspaceService } from "@harness/ui-workspace";
import SessionsPanel from "./panels/SessionsPanel.vue";

export function useSessionsWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  const tabs = inject(UiTabsService);
  const workspaces = inject(UiWorkspaceService);
  const filePicker = inject(UiFilePickerService);
  workbench.use({
    id: "harness.sessions",
    panels: [
      {
        id: "sessions",
        title: "Conversations",
        icon: "i-codicon-comment-discussion",
        component: SessionsPanel,
        location: "left",
        presentation: "view",
        titleActions: [
          {
            id: "open-folder-as-workspace",
            title: "Open folder as workspace",
            icon: "i-codicon-new-folder text-[14px]",
            async run() {
              const folder = await filePicker.pickFolder({
                title: "Open Folder as Workspace",
                initialPath:
                  workspaces.currentWorkspace.value?.folders[0] ?? workspaces.browseRoot.value,
                confirmLabel: "Open Folder",
              });
              if (!folder) return;
              openWorkspaceTab(tabs, workspaces, workspaces.openFolder(folder));
            },
          },
        ],
      },
    ],
  });
}
