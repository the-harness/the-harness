import { Menu, MenuAction } from "@harness/ui-menu";

export interface FilePickerMenuContext {
  readonly directory: string;
  readonly path?: string;
  readonly directoryEntry: boolean;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly multiple: boolean;
  readonly includeHidden: boolean;
  readonly open: () => void;
  readonly select: () => void;
  readonly createFolder: () => void;
  readonly refresh: () => Promise<void>;
  readonly toggleHidden: () => void;
}

export function createFilePickerMenu() {
  return new Menu({
    selection: (context: FilePickerMenuContext) => [
      new MenuAction({ id: "open-folder", label: "Open Folder", visible: context.directoryEntry, run: context.open }),
      new MenuAction({ id: "select", label: context.selected && context.multiple ? "Deselect" : "Select", visible: context.selectable, run: context.select }),
      new MenuAction({ id: "copy-path", label: "Copy Path", run: () => navigator.clipboard.writeText(context.path ?? context.directory) }),
    ],
    directory: (context: FilePickerMenuContext) => [
      new MenuAction({ id: "new-folder", label: "New Folder…", disabled: !context.directory, run: context.createFolder }),
      new MenuAction({ id: "refresh", label: "Refresh", run: context.refresh }),
      new MenuAction({ id: "hidden", label: "Show Hidden Files", type: "checkbox", checked: context.includeHidden, run: context.toggleHidden }),
    ],
  });
}
