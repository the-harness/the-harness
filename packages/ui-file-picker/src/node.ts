import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inject } from "@harness/di";
import { RpcServerService } from "@harness/rpc";
import { FilePickerRpcContract, type FilePickerEntry, type FilePickerListing } from "./contract.ts";

export function useFilePickerHandlers(): void {
  inject(RpcServerService).useHandlers(FilePickerRpcContract, {
    list: listFilePickerDirectory,
    createDirectory: ({ parentPath, name }) => createFilePickerDirectory(parentPath, name),
    resolveSavePath: ({ directory, name }) => resolveFilePickerSavePath(directory, name),
  });
}

const MAX_ENTRIES = 1000;

function expandHome(rawPath: string): string {
  const home = os.homedir();
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(home, rawPath.slice(2));
  }
  return rawPath;
}

export async function listFilePickerDirectory(options: {
  readonly path?: string;
  readonly includeFiles?: boolean;
  readonly includeHidden?: boolean;
}): Promise<FilePickerListing> {
  const home = os.homedir();
  const target = options.path?.trim() ? path.resolve(expandHome(options.path.trim())) : home;
  const parentDir = path.dirname(target);
  const parent = parentDir !== target ? parentDir : null;

  const dir = await fs.opendir(target);
  const entries: FilePickerEntry[] = [];
  let truncated = false;

  try {
    for await (const dirent of dir) {
      const hidden = dirent.name.startsWith(".");
      if (hidden && !options.includeHidden) continue;

      const fullPath = path.join(target, dirent.name);
      let isDir = dirent.isDirectory();
      let isFile = dirent.isFile();

      if (dirent.isSymbolicLink()) {
        try {
          const stat = await fs.stat(fullPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }

      if (!isDir && !(options.includeFiles && isFile)) continue;

      entries.push({
        name: dirent.name,
        path: fullPath,
        type: isDir ? "directory" : "file",
        ...(hidden ? { hidden: true } : {}),
      });

      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    path: target,
    parent,
    home,
    separator: path.sep,
    entries,
    truncated,
  };
}

export async function createFilePickerDirectory(
  parentPath: string,
  name: string,
): Promise<{ path: string }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
    throw new Error("Invalid folder name");
  }
  const target = path.join(path.resolve(expandHome(parentPath)), trimmed);
  await fs.mkdir(target);
  return { path: target };
}

async function resolveFilePickerSavePath(directory: string, name: string) {
  if (!name || name === "." || name === ".." || /[\x00/\\]/.test(name)) {
    throw new Error("Invalid file name");
  }
  const parent = path.resolve(expandHome(directory));
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Select a folder");
  const target = path.join(parent, name);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("The selected name is not a file");
    return { path: target, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path: target, exists: false };
  }
}
