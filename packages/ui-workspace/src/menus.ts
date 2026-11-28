import { Menu, MenuAction } from "@harness/ui-menu";

export interface FileMenuTarget {
  readonly root: string;
  readonly relativePath: string;
  readonly isDirectory: boolean;
}

export interface FileMenuContext {
  readonly target?: FileMenuTarget;
  readonly treeContextId: string;
  readonly rootCount: number;
  readonly canCollapse: boolean;
  readonly folderActionLabel: string;
  readonly isMac: boolean;
  readonly open: () => Promise<void>;
  readonly create: (kind: "new-file" | "new-folder") => void;
  readonly copyPath: (relative: boolean) => Promise<void>;
  readonly rename: () => Promise<void>;
  readonly delete: () => Promise<void>;
  readonly pickRoot: () => Promise<void>;
  readonly removeRoot: () => void;
  readonly refresh: () => void;
  readonly collapseAll: () => void;
}

export interface WorkspaceFolderMenuContext {
  readonly workspaceId: string;
  readonly folder?: string;
  readonly edit: () => void;
  readonly remove: () => void;
  readonly browse: () => Promise<void>;
  readonly add: () => void;
}

export function createWorkspaceFolderMenu() {
  return new Menu({
    folder: (context: WorkspaceFolderMenuContext) => context.folder === undefined ? [] : [
      new MenuAction({ id: "edit", label: "Edit Folder", run: context.edit }),
      new MenuAction({ id: "copy", label: "Copy Path", run: () => navigator.clipboard.writeText(context.folder!) }),
      new MenuAction({ id: "remove", label: "Remove Folder", run: context.remove }),
    ],
    workspace: (context: WorkspaceFolderMenuContext) => [
      new MenuAction({ id: "browse", label: "Browse…", run: context.browse }),
      new MenuAction({ id: "add", label: "Add Folder", run: context.add }),
    ],
  });
}

export function createFileMenu() {
  return new Menu({
    open: (context: FileMenuContext) => context.target && !context.target.isDirectory ? [
      new MenuAction({ id: "open", label: "Open", run: context.open }),
    ] : [],
    create: (context: FileMenuContext) => context.target && !context.target.isDirectory ? [] : [
      new MenuAction({ id: "new-file", label: "New File", disabled: !context.rootCount, run: () => context.create("new-file") }),
      new MenuAction({ id: "new-folder", label: "New Folder", disabled: !context.rootCount, run: () => context.create("new-folder") }),
    ],
    clipboard: (context: FileMenuContext) => context.target ? [
      new MenuAction({ id: "copy-path", label: "Copy Path", run: () => context.copyPath(false) }),
      new MenuAction({ id: "copy-relative-path", label: "Copy Relative Path", run: () => context.copyPath(true) }),
    ] : [],
    edit: (context: FileMenuContext) => context.target?.relativePath ? [
      new MenuAction({ id: "rename", label: "Rename", shortcut: context.isMac ? "Enter" : "F2", run: context.rename }),
      new MenuAction({ id: "delete", label: "Delete…", shortcut: context.isMac ? "⌘⌫" : "Delete", danger: true, run: context.delete }),
    ] : [],
    workspace: (context: FileMenuContext) => context.target?.relativePath ? [] : [
      new MenuAction({ id: "pick-root", label: `${context.folderActionLabel}…`, run: context.pickRoot }),
      new MenuAction({ id: "remove-root", label: "Remove Folder from Workspace", visible: !!context.target && context.rootCount > 1, run: context.removeRoot }),
    ],
    view: (context: FileMenuContext) => context.target?.relativePath ? [] : [
      new MenuAction({ id: "refresh", label: "Refresh Explorer", disabled: !context.rootCount, run: context.refresh }),
      new MenuAction({ id: "collapse-all", label: "Collapse Folders", disabled: !context.canCollapse, run: context.collapseAll }),
    ],
  });
}
