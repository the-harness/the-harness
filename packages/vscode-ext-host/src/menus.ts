import { MenuAction, Menu } from "@harness/ui-menu";
import type { CommentThreadState, CommentAction } from "./main-thread/comments.ts";

export interface ExtensionTreeMenuContext {
  readonly viewId: string;
  readonly node?: {
    readonly id: string;
    readonly label: string;
    readonly collapsibleState: number;
    readonly command?: { readonly command: string };
    readonly resourceUri?: { readonly path: string };
  };
  readonly expanded: boolean;
  readonly canCollapse: boolean;
  readonly open: () => Promise<void>;
  readonly toggle: () => void;
  readonly refresh: () => Promise<void>;
  readonly collapseAll: () => void;
}

export interface CommentMenuContext {
  readonly thread: CommentThreadState;
  readonly comment?: CommentThreadState["comments"][number];
  readonly actions: readonly CommentAction[];
  readonly invoke: (command: string) => Promise<void>;
  readonly reveal: () => Promise<void>;
  readonly toggle: () => Promise<void>;
}

export function createExtensionTreeMenu() {
  return new Menu({
    node: (context: ExtensionTreeMenuContext) => [
      new MenuAction({ id: "open", label: "Open", visible: !!context.node?.command, run: context.open }),
      new MenuAction({ id: "expand", label: context.expanded ? "Collapse" : "Expand", visible: !!context.node?.collapsibleState, run: context.toggle }),
      new MenuAction({ id: "copy-label", label: "Copy Label", visible: !!context.node, run: () => navigator.clipboard.writeText(context.node!.label) }),
      new MenuAction({ id: "copy-path", label: "Copy Path", visible: !!context.node?.resourceUri, run: () => navigator.clipboard.writeText(context.node!.resourceUri!.path) }),
    ],
    view: (context: ExtensionTreeMenuContext) => [
      new MenuAction({ id: "refresh", label: "Refresh", run: context.refresh }),
      new MenuAction({ id: "collapse-all", label: "Collapse All", disabled: !context.canCollapse, run: context.collapseAll }),
    ],
  });
}

export function createCommentMenu() {
  return new Menu({
    commands: (context: CommentMenuContext) => context.actions.map((action) => new MenuAction({
      id: action.command, label: action.title, disabled: !action.enabled, run: () => context.invoke(action.command),
    })),
    thread: (context: CommentMenuContext) => [
      new MenuAction({ id: "copy", label: context.comment ? "Copy Comment" : "Copy Thread",
        run: () => navigator.clipboard.writeText((context.comment ? [context.comment] : context.thread.comments)
          .map((item) => typeof item.body === "string" ? item.body : item.body.value).join("\n\n")) }),
      new MenuAction({ id: "reveal", label: "Go to File", run: context.reveal }),
      new MenuAction({ id: "collapse", label: context.thread.collapsibleState === 1 ? "Collapse Thread" : "Expand Thread", run: context.toggle }),
    ],
  });
}
