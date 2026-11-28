import { Menu, MenuAction } from "@harness/ui-menu";
import type { TreeAction, TreeNode } from "@harness/ui-tree-view";

export interface SessionMenuContext {
  readonly node?: TreeNode;
  readonly workspaceId?: string;
  readonly canCollapse: boolean;
  readonly createConversation: () => void;
  readonly open: () => void;
  readonly runAction: (action: TreeAction) => void;
  readonly openFolder?: () => void;
  readonly collapseAll: () => void;
}

export function createSessionMenu() {
  return new Menu({
    actions: (context: SessionMenuContext) => [
      new MenuAction({ id: "new-conversation", label: "New conversation", visible: !context.node || context.node.id.startsWith("workspace:"), run: context.createConversation }),
      new MenuAction({ id: "open", label: "Open", visible: !!context.node, run: context.open }),
      ...(context.node?.actions ?? []).filter((action) => !isDestructive(action)).map((action) => new MenuAction({
        id: action.id, label: action.label, shortcut: action.id.startsWith("rename") ? "F2" : undefined,
        run: () => context.runAction(action),
      })),
      new MenuAction({ id: "open-folder", label: "Open Folder as Workspace…", visible: !context.node && !!context.openFolder, run: () => context.openFolder?.() }),
      new MenuAction({ id: "collapse-all", label: "Collapse All", visible: !context.node, disabled: !context.canCollapse, run: context.collapseAll }),
    ],
    destructive: (context: SessionMenuContext) =>
      (context.node?.actions ?? []).filter(isDestructive).map((action) => new MenuAction({
        id: action.id, label: action.label, danger: true, run: () => context.runAction(action),
      })),
  });
}

function isDestructive(action: TreeAction): boolean {
  return action.id === "delete" || action.id === "delete-workspace";
}
