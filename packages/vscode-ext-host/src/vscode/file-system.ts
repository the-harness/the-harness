import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, posix } from "node:path";
import { Disposable, FilePermission, FileSystemError, FileType, Uri, type Event } from "./types.ts";

type FileStat = { type: number; ctime: number; mtime: number; size: number; permissions?: number };
type FileChange = { type: number; uri: Uri };
type Result<T> = T | PromiseLike<T>;
type WatchOptions = { recursive: boolean; excludes: readonly string[] };
// Extensions implement this interface to serve their URI scheme.
interface FileSystemProvider {
  readonly onDidChangeFile: Event<readonly FileChange[]>;
  stat(uri: Uri): Result<FileStat>;
  readDirectory(uri: Uri): Result<[string, number][]>;
  readFile(uri: Uri): Result<Uint8Array>;
  writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Result<void>;
  createDirectory(uri: Uri): Result<void>;
  delete(uri: Uri, options: { recursive: boolean }): Result<void>;
  rename(source: Uri, target: Uri, options: { overwrite: boolean }): Result<void>;
  copy?(source: Uri, target: Uri, options: { overwrite: boolean }): Result<void>;
  watch(uri: Uri, options: WatchOptions): { dispose(): unknown };
}

function diskEntryType(entry: Pick<Dirent, "isDirectory" | "isFile">): number {
  if (entry.isDirectory()) return FileType.Directory;
  if (entry.isFile()) return FileType.File;
  return FileType.Unknown;
}

function translateError(error: unknown, uri: Uri): never {
  if (error instanceof FileSystemError) throw error;
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") throw FileSystemError.FileNotFound(uri);
  if (code === "EEXIST") throw FileSystemError.FileExists(uri);
  if (code === "ENOTDIR") throw FileSystemError.FileNotADirectory(uri);
  if (code === "EISDIR") throw FileSystemError.FileIsADirectory(uri);
  if (code === "EACCES" || code === "EPERM") throw FileSystemError.NoPermissions(uri);
  throw error;
}

export function createFileSystemApi(
  activateByEvent: ((event: string) => Promise<void>) | undefined,
  onChanges: (changes: readonly FileChange[]) => void,
) {
  const providers = new Map<
    string,
    {
      provider: FileSystemProvider;
      readonly: boolean;
      caseSensitive: boolean;
      subscription: { dispose(): unknown };
    }
  >();
  const watches = new Set<{
    uri: Uri;
    options: WatchOptions;
    subscription?: { dispose(): unknown };
  }>();
  const hasProvider = (scheme: string) => scheme === "file" || providers.has(scheme);
  function activateProvider(scheme: string): Promise<void> | undefined {
    const activation = activateByEvent?.(`onFileSystem:${scheme}`);
    if (!hasProvider(scheme)) return activation;
    void activation?.catch(console.error);
  }

  const provider = (uri: Uri, write = false): FileSystemProvider | undefined => {
    if (uri.scheme === "file") return undefined;
    const entry = providers.get(uri.scheme);
    if (!entry) throw FileSystemError.Unavailable(`No file system provider for ${uri.scheme}`);
    if (write && entry.readonly) throw FileSystemError.NoPermissions(uri);
    return entry.provider;
  };
  const safely = async <T>(uri: Uri, action: () => Result<T>): Promise<T> => {
    try {
      const activation = activateProvider(uri.scheme);
      if (activation) await activation;
      return await action();
    } catch (error) {
      return translateError(error, uri);
    }
  };
  const existing = async (uri: Uri) => {
    try {
      await fs.lstat(uri.fsPath);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
  };
  async function statIfPresent(uri: Uri): Promise<FileStat | undefined> {
    try {
      return await api.stat(uri);
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "FileNotFound") return undefined;
      throw error;
    }
  }

  function captureProviders(...uris: Uri[]): () => void {
    const registrations = uris.map(({ scheme }) => [scheme, providers.get(scheme)] as const);
    return () => {
      if (registrations.some(([scheme, entry]) => providers.get(scheme) !== entry))
        throw FileSystemError.Unavailable("File system provider changed during operation");
    };
  }

  async function ensureParent(
    uri: Uri,
    destination: FileSystemProvider | undefined,
    checkProviders: () => void,
  ): Promise<void> {
    const parent =
      uri.scheme === "file"
        ? Uri.file(dirname(uri.fsPath))
        : uri.with({ path: posix.dirname(uri.path) });
    if (parent.path === uri.path || parent.path === "/" || parent.path === ".") return;
    await ensureDirectory(parent, destination, checkProviders);
  }

  async function ensureDirectory(
    uri: Uri,
    destination: FileSystemProvider | undefined,
    checkProviders: () => void,
  ): Promise<void> {
    if (!destination) {
      await safely(uri, () => fs.mkdir(uri.fsPath, { recursive: true }));
      return;
    }
    const entry = await statIfPresent(uri);
    checkProviders();
    if (entry) {
      if (!(entry.type & FileType.Directory)) throw FileSystemError.FileNotADirectory(uri);
      return;
    }
    await ensureParent(uri, destination, checkProviders);
    checkProviders();
    try {
      await safely(uri, () => destination.createDirectory(uri));
    } catch (error) {
      if (!(error instanceof FileSystemError) || error.code !== "FileExists") throw error;
      checkProviders();
      const created = await statIfPresent(uri);
      if (!created || !(created.type & FileType.Directory)) throw error;
    }
    checkProviders();
  }

  async function remove(
    uri: Uri,
    remote: FileSystemProvider | undefined,
    recursive: boolean,
  ): Promise<void> {
    if (remote) {
      await remote.delete(uri, { recursive });
    } else if (recursive) {
      await fs.rm(uri.fsPath, { recursive: true });
    } else if ((await fs.lstat(uri.fsPath)).isDirectory()) {
      await fs.rmdir(uri.fsPath);
    } else {
      await fs.rm(uri.fsPath);
    }
  }

  async function readLocalDirectory(
    uri: Uri,
    skipUnreadableLinks: boolean,
  ): Promise<[string, number][]> {
    const children = await fs.readdir(uri.fsPath, { withFileTypes: true });
    const entries = await Promise.all(
      children.map(async (entry): Promise<[string, number] | undefined> => {
        if (!entry.isSymbolicLink()) return [entry.name, diskEntryType(entry)];
        try {
          const stat = await api.stat(Uri.joinPath(uri, entry.name));
          return [entry.name, stat.type];
        } catch (error) {
          if (!skipUnreadableLinks) throw error;
          return undefined;
        }
      }),
    );
    return entries.filter((entry) => entry !== undefined);
  }

  async function copyTree(
    source: Uri,
    target: Uri,
    type: number,
    destination: FileSystemProvider | undefined,
    checkProviders: () => void,
  ): Promise<void> {
    checkProviders();
    if (!(type & FileType.Directory)) {
      const bytes = await api.readFile(source);
      checkProviders();
      await safely(target, () =>
        destination
          ? destination.writeFile(target, bytes, { create: true, overwrite: false })
          : fs.writeFile(target.fsPath, bytes, { flag: "wx" }),
      );
      return;
    }
    if (type & FileType.SymbolicLink) {
      throw FileSystemError.Unavailable(`Cannot copy a directory symlink: ${source.toString()}`);
    }
    await safely(target, () =>
      destination ? destination.createDirectory(target) : fs.mkdir(target.fsPath),
    );
    try {
      const entries =
        source.scheme === "file"
          ? await safely(source, () => readLocalDirectory(source, false))
          : await api.readDirectory(source);
      for (const [name, childType] of entries) {
        if (
          !name ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          (target.scheme === "file" && process.platform === "win32" && name.includes("\\"))
        ) {
          throw new Error(`Invalid directory entry: ${name}`);
        }
        await copyTree(
          Uri.joinPath(source, name),
          Uri.joinPath(target, name),
          childType,
          destination,
          checkProviders,
        );
      }
    } catch (error) {
      await remove(target, destination, true).catch(() => undefined);
      throw error;
    }
  }

  async function transfer(
    source: Uri,
    target: Uri,
    destination: FileSystemProvider | undefined,
    overwrite: boolean,
    move = false,
  ): Promise<void> {
    if (source.toString() === target.toString()) return;
    if (
      source.scheme === target.scheme &&
      source.authority === target.authority &&
      source.query === target.query &&
      source.fragment === target.fragment
    ) {
      const normalize = (value: Uri) => {
        const path = posix.normalize(value.path).replace(/\/+$/, "");
        return providers.get(value.scheme)?.caseSensitive ? path : path.toLowerCase();
      };
      const from = normalize(source);
      const to = normalize(target);
      if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
        throw FileSystemError.NoPermissions(`Overlapping transfer paths: ${source} and ${target}`);
      }
    }

    const checkProviders = captureProviders(source, target);
    const sourceStat = await api.stat(source);
    checkProviders();
    if (move && (sourceStat.permissions ?? 0) & FilePermission.Readonly) {
      throw FileSystemError.NoPermissions(source);
    }
    if (sourceStat.type & FileType.Directory && sourceStat.type & FileType.SymbolicLink) {
      throw FileSystemError.Unavailable(`Cannot copy a directory symlink: ${source.toString()}`);
    }
    const existingTarget = await statIfPresent(target);
    if (existingTarget && !overwrite) throw FileSystemError.FileExists(target);
    if ((existingTarget?.permissions ?? 0) & FilePermission.Readonly) {
      throw FileSystemError.NoPermissions(target);
    }
    checkProviders();
    await ensureParent(target, destination, checkProviders);
    checkProviders();
    if (existingTarget) await api.delete(target, { recursive: true });
    await copyTree(source, target, sourceStat.type, destination, checkProviders);
    checkProviders();
    if (move) await api.delete(source, { recursive: true });
  }

  const api = {
    isWritableFileSystem(scheme: string): boolean | undefined {
      if (scheme === "file") return true;
      const entry = providers.get(scheme);
      return entry ? !entry.readonly : undefined;
    },
    stat: (uri: Uri): Promise<FileStat> =>
      safely(uri, async () => {
        const remote = provider(uri);
        if (remote) return await remote.stat(uri);
        const entry = await fs.lstat(uri.fsPath);
        const isLink = entry.isSymbolicLink();
        const stat = isLink
          ? await fs.stat(uri.fsPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return entry;
            })
          : entry;
        return {
          type: diskEntryType(stat) | (isLink ? FileType.SymbolicLink : 0),
          ctime: stat.birthtimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      }),
    readFile: (uri: Uri): Promise<Uint8Array> =>
      safely(uri, async () => {
        const remote = provider(uri);
        return new Uint8Array(remote ? await remote.readFile(uri) : await fs.readFile(uri.fsPath));
      }),
    readDirectory: (uri: Uri): Promise<[string, number][]> =>
      safely(uri, async () => {
        const remote = provider(uri);
        return remote ? await remote.readDirectory(uri) : await readLocalDirectory(uri, true);
      }),
    writeFile: (uri: Uri, content: Uint8Array): Promise<void> =>
      safely(uri, async () => {
        const remote = provider(uri, true);
        const checkProviders = captureProviders(uri);
        const entry = await statIfPresent(uri);
        checkProviders();
        if ((entry?.type ?? 0) & FileType.Directory) throw FileSystemError.FileIsADirectory(uri);
        if ((entry?.permissions ?? 0) & FilePermission.Readonly)
          throw FileSystemError.NoPermissions(uri);
        if (!entry) await ensureParent(uri, remote, checkProviders);
        checkProviders();
        if (remote) await remote.writeFile(uri, content, { create: true, overwrite: true });
        else await fs.writeFile(uri.fsPath, content);
      }),
    createDirectory: (uri: Uri): Promise<void> =>
      safely(uri, () => ensureDirectory(uri, provider(uri, true), captureProviders(uri))),
    delete: (uri: Uri, options: { recursive?: boolean; useTrash?: boolean } = {}): Promise<void> =>
      safely(uri, async () => {
        if (options.useTrash)
          throw FileSystemError.Unavailable("Moving files to trash is not supported");
        await remove(uri, provider(uri, true), options.recursive ?? false);
      }),
    rename: (source: Uri, target: Uri, options: { overwrite?: boolean } = {}): Promise<void> =>
      safely(source, async () => {
        const activation = source.scheme !== target.scheme && activateProvider(target.scheme);
        if (activation) await activation;
        const remote = provider(source, true);
        if (source.scheme !== target.scheme) {
          await transfer(source, target, provider(target, true), options.overwrite ?? false, true);
        } else if (remote) {
          await remote.rename(source, target, { overwrite: options.overwrite ?? false });
        } else {
          if (!options.overwrite && (await existing(target)))
            throw FileSystemError.FileExists(target);
          await fs.rename(source.fsPath, target.fsPath);
        }
      }),
    copy: (source: Uri, target: Uri, options: { overwrite?: boolean } = {}): Promise<void> =>
      safely(source, async () => {
        const activation = source.scheme !== target.scheme && activateProvider(target.scheme);
        if (activation) await activation;
        const remote = provider(source);
        const destination = provider(target, true);
        if (source.scheme === target.scheme && remote?.copy)
          await remote.copy(source, target, { overwrite: options.overwrite ?? false });
        else if (source.scheme === "file" && target.scheme === "file")
          await fs.cp(source.fsPath, target.fsPath, {
            recursive: true,
            force: options.overwrite ?? false,
            errorOnExist: !options.overwrite,
          });
        else await transfer(source, target, destination, options.overwrite ?? false);
      }),
  };
  return {
    activateProvider,
    hasProvider,
    fs: api,
    providerRegistration(scheme: string): object | undefined {
      return providers.get(scheme);
    },
    isPathCaseSensitive(scheme: string): boolean {
      return scheme === "file"
        ? process.platform === "linux"
        : (providers.get(scheme)?.caseSensitive ?? false);
    },
    registerFileSystemProvider(
      scheme: string,
      value: FileSystemProvider,
      options?: { isCaseSensitive?: boolean; isReadonly?: boolean | { value: string } },
    ) {
      if (scheme === "file" || providers.has(scheme))
        throw new Error(`File system provider already registered: ${scheme}`);
      const entry = {
        provider: value,
        caseSensitive: Boolean(options?.isCaseSensitive),
        readonly: Boolean(options?.isReadonly),
        caseSensitive: options?.isCaseSensitive ?? false,
        subscription: value.onDidChangeFile(onChanges),
      };
      providers.set(scheme, entry);
      for (const watch of watches)
        if (watch.uri.scheme === scheme) watch.subscription = value.watch(watch.uri, watch.options);
      return new Disposable(() => {
        if (providers.get(scheme) === entry) providers.delete(scheme);
        for (const watch of watches)
          if (watch.uri.scheme === scheme) {
            watch.subscription?.dispose();
            watch.subscription = undefined;
          }
        entry.subscription.dispose();
      });
    },
    watch(uri: Uri, options: WatchOptions) {
      if (uri.scheme === "file") return undefined;
      const watch = {
        uri,
        options,
        subscription: providers.get(uri.scheme)?.provider.watch(uri, options),
      };
      watches.add(watch);
      void activateProvider(uri.scheme)?.catch(console.error);
      return new Disposable(() => {
        watches.delete(watch);
        watch.subscription?.dispose();
      });
    },
  };
}
