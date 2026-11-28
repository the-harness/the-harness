import { inject } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { onScopeDispose, shallowRef, type Ref } from "vue";
import { FilePickerRpcContract, type FilePickerListing } from "./contract.ts";
import { createFilePickerMenu } from "./menus.ts";

export type { FilePickerMenuContext } from "./menus.ts";

export interface FilePickerOptions {
  readonly mode?: "file" | "directory";
  readonly title?: string;
  readonly initialPath?: string;
  readonly confirmLabel?: string;
}

export interface FilePickerDialogOptions extends Omit<FilePickerOptions, "mode"> {
  readonly initialName?: string;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

export interface FilePickerOpenOptions extends FilePickerDialogOptions {
  readonly mode?: "file" | "directory" | "any";
  readonly multiple?: boolean;
}

export interface FilePickerSession extends FilePickerDialogOptions {
  readonly mode: "file" | "directory" | "any" | "save";
  readonly title: string;
  readonly confirmLabel: string;
  readonly multiple?: boolean;
  readonly selectDirectoryRows?: boolean;
  readonly resolve: (result: string | readonly string[] | undefined) => void;
}

export class UiFilePickerService {
  readonly menu = createFilePickerMenu();
  readonly activeSession: Ref<FilePickerSession | null> = shallowRef(null);
  private readonly rpc = inject(RpcClientService).use(FilePickerRpcContract);

  constructor() {
    onScopeDispose(() => this.activeSession.value?.resolve(undefined));
  }

  async pick(options: FilePickerOptions = {}): Promise<string | undefined> {
    const mode = options.mode ?? "file";
    const label = mode === "directory" ? "Select Folder" : "Select File";
    return (
      await this.show({
        ...options,
        mode,
        title: options.title ?? label,
        confirmLabel: options.confirmLabel ?? label,
      })
    )?.[0];
  }

  pickFolder(options: Omit<FilePickerOptions, "mode"> = {}): Promise<string | undefined> {
    return this.pick({ ...options, mode: "directory" });
  }

  pickFile(options: Omit<FilePickerOptions, "mode"> = {}): Promise<string | undefined> {
    return this.pick({ ...options, mode: "file" });
  }

  pickOpen(
    options: FilePickerOpenOptions = {},
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    return this.show(
      {
        ...options,
        mode: options.mode ?? "file",
        title: options.title ?? "Open",
        confirmLabel: options.confirmLabel ?? "Open",
        selectDirectoryRows: true,
      },
      signal,
    );
  }

  async pickSavePath(
    options: FilePickerDialogOptions = {},
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return (
      await this.show(
        {
          ...options,
          mode: "save",
          title: options.title ?? "Save As",
          confirmLabel: options.confirmLabel ?? "Save",
        },
        signal,
      )
    )?.[0];
  }

  private show(options: Omit<FilePickerSession, "resolve">, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(undefined);
    this.activeSession.value?.resolve(undefined);
    return new Promise<readonly string[] | undefined>((resolve) => {
      const onAbort = () => session.resolve(undefined);
      const session: FilePickerSession = {
        ...options,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          if (this.activeSession.value !== session) return;
          this.activeSession.value = null;
          resolve(typeof result === "string" ? [result] : result);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.activeSession.value = session;
      if (signal?.aborted) onAbort();
    });
  }

  async list(
    options: {
      readonly path?: string;
      readonly includeFiles?: boolean;
      readonly includeHidden?: boolean;
    } = {},
  ): Promise<FilePickerListing> {
    return await this.rpc.list(options);
  }

  async createDirectory(parentPath: string, name: string): Promise<string> {
    const result = await this.rpc.createDirectory({ parentPath, name });
    return result.path;
  }

  resolveSavePath(directory: string, name: string): Promise<{ path: string; exists: boolean }> {
    return this.rpc.resolveSavePath({ directory, name });
  }
}
