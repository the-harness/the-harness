```ts
interface FilePickerOptions {
  readonly mode?: "file" | "directory";
  readonly title?: string;
  readonly initialPath?: string;
  readonly confirmLabel?: string;
}

interface FilePickerDialogOptions extends Omit<FilePickerOptions, "mode"> {
  readonly initialName?: string;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

interface FilePickerOpenOptions extends FilePickerDialogOptions {
  readonly mode?: "file" | "directory" | "any";
  readonly multiple?: boolean;
}

interface FilePickerSession extends FilePickerDialogOptions {
  readonly mode: "file" | "directory" | "any" | "save";
  readonly title: string;
  readonly confirmLabel: string;
  readonly multiple?: boolean;
  readonly selectDirectoryRows?: boolean;
  readonly resolve: (result: string | readonly string[] | undefined) => void;
}

interface FilePickerMenuContext {
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

class UiFilePickerService {
  readonly menu: Menu<FilePickerMenuContext, "selection" | "directory">; // Scoped file-dialog menu contributions.
  readonly activeSession: Ref<FilePickerSession | null>;
  pick(options?: FilePickerOptions): Promise<string | undefined>; // 打开文件/文件夹选择器弹窗
  pickFolder(options?: Omit<FilePickerOptions, "mode">): Promise<string | undefined>;
  pickFile(options?: Omit<FilePickerOptions, "mode">): Promise<string | undefined>;
  pickOpen(
    options?: FilePickerOpenOptions,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined>;
  pickSavePath(
    options?: FilePickerDialogOptions,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  list(options?: {
    readonly path?: string;
    readonly includeFiles?: boolean;
    readonly includeHidden?: boolean;
  }): Promise<FilePickerListing>;
  createDirectory(parentPath: string, name: string): Promise<string>;
  resolveSavePath(directory: string, name: string): Promise<{ path: string; exists: boolean }>;
}

function useFilePickerHandlers(): void; // 从 @harness/ui-file-picker/node 注册选择器 RPC
```
