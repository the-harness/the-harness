import { TabDescriptor, type UiTabsService } from "@harness/ui-workbench";
import type { UiWorkspaceService } from "@harness/ui-workspace";
import { variant } from "@harness/variants";
import { computed, watch } from "vue";

@variant("core:web:workspace-tab")
export class WorkspaceTabDescriptor extends TabDescriptor {
  declare readonly workspaceId: string;
  declare readonly title?: string;

  get key(): string {
    return `workspace:${this.workspaceId}`;
  }

  get defaultTitle(): string {
    return this.title ?? "Workspace";
  }
}

export function openWorkspaceTab(
  tabs: UiTabsService,
  workspaceService: UiWorkspaceService,
  workspace: { id: string; name?: string },
  options?: { preserveFocus?: boolean },
): void {
  workspaceService.activeWorkspaceId.value = workspace.id;
  const chatGroupId = (
    tabs as unknown as {
      dock?: { getPanel(id: string): { group?: { id: string } } | undefined };
    }
  ).dock?.getPanel("chat")?.group?.id;
  const tab = tabs.open(
    WorkspaceTabDescriptor.create({
      workspaceId: workspace.id,
      title: workspace.name,
    }),
    {
      ...(chatGroupId ? { groupId: chatGroupId } : {}),
      preserveFocus: options?.preserveFocus,
    },
  );
  tabs.runOnce(tab, "workspace", () => {
    const scopedWorkspace = computed(() => workspaceService.getWorkspace(workspace.id));
    watch(
      () => scopedWorkspace.value?.name,
      (name) => {
        if (name) tab.title = name;
      },
      { immediate: true },
    );
  });
}
