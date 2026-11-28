import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { FileSystemError, Uri } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

interface FileDialogOptions {
  readonly defaultUri?: Uri;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
  readonly title?: string;
}

export interface OpenDialogOptions extends FileDialogOptions {
  readonly openLabel?: string;
  readonly canSelectFiles?: boolean;
  readonly canSelectFolders?: boolean;
  readonly canSelectMany?: boolean;
}

export interface SaveDialogOptions extends FileDialogOptions {
  readonly saveLabel?: string;
}

export function createFileDialogs(bridge: ExtHostBridge) {
  async function optionsForDialog(options: FileDialogOptions) {
    const { defaultUri, filters, title } = options;
    const display = { filters, title };
    if (!defaultUri) return { ...display, initialPath: bridge.getWorkspaceRoots()[0] };
    if (defaultUri.scheme !== "file")
      throw FileSystemError.Unavailable(
        `File dialogs cannot browse the ${defaultUri.scheme} scheme`,
      );
    const path = defaultUri.fsPath;
    try {
      if ((await stat(path)).isDirectory()) return { ...display, initialPath: path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ...display, initialPath: dirname(path), initialName: basename(path) };
  }

  return {
    async showOpenDialog(options: OpenDialogOptions = {}): Promise<Uri[] | undefined> {
      const files = options.canSelectFiles ?? true;
      const folders = options.canSelectFolders ?? false;
      const mode = folders ? (files ? "any" : "directory") : "file";
      const selected = (await bridge.callMain("window.showOpenDialog", {
        ...(await optionsForDialog(options)),
        mode,
        multiple: options.canSelectMany,
        confirmLabel: options.openLabel,
      })) as readonly string[] | undefined;
      return selected?.map((path) => Uri.file(path));
    },
    async showSaveDialog(options: SaveDialogOptions = {}): Promise<Uri | undefined> {
      const selected = (await bridge.callMain("window.showSaveDialog", {
        ...(await optionsForDialog(options)),
        confirmLabel: options.saveLabel,
      })) as string | undefined;
      return selected === undefined ? undefined : Uri.file(selected);
    },
  };
}
