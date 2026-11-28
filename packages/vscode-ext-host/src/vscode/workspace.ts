import * as path from "node:path";
import picomatch from "picomatch";
import {
  ExcludeSettingOptions,
  type CancellationToken as SearchCancellationToken,
  type TextDocumentSnapshot,
} from "@harness/vscode-types";
import { findWorkspaceFiles, type FindFiles2Options } from "../node/file-search.ts";
import type { ExtHostBridge } from "./bridge.ts";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  FileSystemError,
  Position,
  Range,
  Uri,
  type Event,
} from "./types.ts";
import { createFileSystemApi } from "./file-system.ts";
import { createFileOperations } from "./file-operations.ts";
import { createNotebookApi } from "./notebooks.ts";
import { createTunnelApi } from "./tunnels.ts";
import { createWorkspaceFeatures } from "./workspace-features.ts";
import { createConfigurationApi } from "./configuration.ts";
import { getTextDocuments, reviveTextDocument, virtualDocumentViewIds } from "./document.ts";

export type GlobPattern =
  | string
  | {
      baseUri?: { scheme: string; path?: string; authority?: string };
      base?: string;
      pattern: string;
    };
type CancellationToken = { readonly isCancellationRequested: boolean };
type Folder = { uri: Uri; name: string; index: number };
type FileChange = { type: string; path: string; uri?: Uri };
type TextSearchOptions = { include?: GlobPattern; exclude?: GlobPattern; maxResults?: number };
type TextSearchResult = { uri: Uri; ranges: Range; preview: { text: string; matches: Range } };
type TextSearchHit = { path: string; line: number; text: string; start: number; end: number };
type ContentProvider = {
  onDidChange?: Event<Uri>;
  provideTextDocumentContent(
    uri: Uri,
    token: import("@harness/vscode-types").CancellationToken,
  ): string | undefined | null | PromiseLike<string | undefined | null>;
};
type ContentReader = ContentProvider["provideTextDocumentContent"];
type HostDocument = ReturnType<typeof reviveTextDocument>;

function watcherRelativePath(base: Uri, uri: Uri, caseSensitive: boolean): string | undefined {
  if (base.scheme !== uri.scheme || base.authority !== uri.authority) return undefined;
  const basePath = caseSensitive ? base.path : base.path.toLowerCase();
  const uriPath = caseSensitive ? uri.path : uri.path.toLowerCase();
  const relative = path.posix.relative(basePath || "/", uriPath || "/");
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
    return undefined;
  return relative;
}

export function createWorkspaceNamespace(bridge: ExtHostBridge) {
  const openDocEmitter = new EventEmitter<ReturnType<typeof reviveTextDocument>>();
  const closeDocEmitter = new EventEmitter<ReturnType<typeof reviveTextDocument>>();
  const saveDocEmitter = new EventEmitter<ReturnType<typeof reviveTextDocument>>();
  const changeDocEmitter = new EventEmitter<unknown>();
  const changeFoldersEmitter = new EventEmitter<{ added: Folder[]; removed: Folder[] }>();
  const fileEmitter = new EventEmitter<FileChange>();
  const contentProviders = new Map<string, ContentReader>();
  const documentProviders = new WeakMap<HostDocument, ContentReader | undefined>();
  const documentOpens = new Map<
    string,
    { source: object | undefined; promise: Promise<HostDocument> }
  >();
  const refreshes = new WeakMap<HostDocument, number>();
  const fileSystem = createFileSystemApi(bridge.activateByEvent, (changes) => {
    for (const change of changes) {
      fileEmitter.fire({
        type: change.type === 1 ? "change" : change.type === 2 ? "add" : "unlink",
        path: change.uri.path,
        uri: change.uri,
      });
      if (change.type === 1 && change.uri.scheme !== "file")
        void refreshVirtualDocument(change.uri).catch(console.error);
    }
  });
  const notebooks = createNotebookApi(bridge, fileSystem.fs);
  const { applyNotebookEdit, applyCellTextEdits, ...notebookNamespace } = notebooks;
  const fileOperations = createFileOperations(bridge, fileSystem.fs, {
    applyNotebookEdit,
    applyCellTextEdits,
  });
  async function readVirtualDocument(uri: Uri, read?: ContentReader): Promise<string> {
    if (!read) return new TextDecoder().decode(await fileSystem.fs.readFile(uri));
    const cancellation = new CancellationTokenSource();
    try {
      const text = await read(uri, cancellation.token);
      if (typeof text !== "string")
        throw FileSystemError.Unavailable(`No document content for ${uri}`);
      return text;
    } finally {
      cancellation.dispose();
    }
  }
  function documentSource(scheme: string): object | undefined {
    return scheme === "file"
      ? undefined
      : (contentProviders.get(scheme) ?? fileSystem.providerRegistration(scheme));
  }
  async function loadTextDocument(uri: Uri, source: object | undefined): Promise<HostDocument> {
    const checkSource = () => {
      if (source !== documentSource(uri.scheme))
        throw FileSystemError.Unavailable(`Document content provider changed for ${uri}`);
    };
    checkSource();
    const provider = contentProviders.get(uri.scheme);
    const documents = getTextDocuments(bridge);
    let snapshot: TextDocumentSnapshot;
    if (uri.scheme === "file")
      snapshot = (await bridge.callMain(
        "workspace.openTextDocument",
        uri.toJSON(),
      )) as TextDocumentSnapshot;
    else {
      const text = await readVirtualDocument(uri, provider);
      checkSource();
      const firstLine = text.split(/\r?\n/, 1)[0]!;
      const language = await bridge.callMain(
        "workspace.resolveDocumentLanguage",
        uri.path,
        firstLine,
      );
      checkSource();
      const opened = documents.get(uri.toString());
      if (opened) return opened;
      snapshot = {
        uri: uri.toJSON(),
        text,
        version: 1,
        languageId: typeof language === "string" ? language : "plaintext",
        isDirty: false,
        eol: text.includes("\r\n") ? 2 : 1,
      };
    }
    const existed = documents.has(Uri.from(snapshot.uri).toString());
    const document = reviveTextDocument(bridge, snapshot);
    if (uri.scheme !== "file") documentProviders.set(document, provider);
    if (!existed) {
      openDocEmitter.fire(document);
      if (uri.scheme !== "file")
        void bridge.activateByEvent?.(`onLanguage:${document.languageId}`).catch(console.error);
    }
    return document;
  }
  function closeTextDocument(document: HostDocument): void {
    document.update({ ...document.toJSON(), isClosed: true });
    getTextDocuments(bridge).delete(document.uri.toString());
    closeDocEmitter.fire(document);
  }
  bridge.commandHandlers.set("__ws.closeVirtualTextDocument", (id, resource) => {
    const key = Uri.from(resource as TextDocumentSnapshot["uri"]).toString();
    const document = getTextDocuments(bridge).get(key);
    if (document && virtualDocumentViewIds.get(document) === id) closeTextDocument(document);
  });
  async function refreshVirtualDocument(uri: Uri): Promise<void> {
    const document = getTextDocuments(bridge).get(uri.toString());
    if (!document) return;
    const version = document.version;
    const refresh = (refreshes.get(document) ?? 0) + 1;
    refreshes.set(document, refresh);
    const isCurrent = () =>
      !document.isClosed && document.version === version && refreshes.get(document) === refresh;
    const provider = documentProviders.has(document)
      ? documentProviders.get(document)
      : contentProviders.get(uri.scheme);
    const text = await readVirtualDocument(uri, provider).catch((error: unknown) => {
      if (isCurrent()) throw error;
    });
    if (text === undefined || !isCurrent() || text === document.getText()) return;
    const oldText = document.getText();
    const range = new Range(new Position(0, 0), document.positionAt(oldText.length));
    document.update({
      ...document.toJSON(),
      text,
      version: version + 1,
      eol: text.includes("\r\n") ? 2 : 1,
    });
    changeDocEmitter.fire({
      document,
      contentChanges: [{ range, rangeOffset: 0, rangeLength: oldText.length, text }],
    });
    const viewId = virtualDocumentViewIds.get(document);
    if (viewId && !document.isClosed)
      void bridge
        .callMain("window.updateVirtualTextDocument", viewId, document.toJSON())
        .catch(console.error);
  }
  const configuration = createConfigurationApi(bridge);
  const features = createWorkspaceFeatures(bridge);
  const tunnels = createTunnelApi();
  let folderSnapshot: Folder[] | undefined;
  const folders = (): Folder[] =>
    folderSnapshot ??
    bridge
      .getWorkspaceRoots()
      .map((root, index) => ({ uri: Uri.file(root), name: path.basename(root) || root, index }));

  function workspacePath(uri: Uri): string {
    const uriPath = uri.path.replace(/\/+$/, "");
    return uri.scheme === "file" && process.platform !== "linux" ? uriPath.toLowerCase() : uriPath;
  }

  function containingFolder(uri: Uri, skipExact = false): Folder | undefined {
    const resourcePath = workspacePath(uri);
    let match: Folder | undefined;
    let matchLength = -1;
    for (const folder of folders()) {
      if (
        uri.scheme !== folder.uri.scheme ||
        uri.authority.toLowerCase() !== folder.uri.authority.toLowerCase()
      ) {
        continue;
      }
      const root = workspacePath(folder.uri);
      if (
        root.length > matchLength &&
        (resourcePath.startsWith(`${root}/`) || (!skipExact && resourcePath === root))
      ) {
        match = folder;
        matchLength = root.length;
      }
    }
    return match;
  }

  const decodeFolder = (folder: {
    uri: { scheme?: string; path: string; authority?: string };
    name: string;
    index: number;
  }): Folder => ({
    ...folder,
    uri: Uri.from({ ...folder.uri, scheme: folder.uri.scheme ?? "file" }),
  });

  bridge.commandHandlers.set("__ws.syncDocuments", (raw) => {
    const snapshots = raw as TextDocumentSnapshot[];
    const keys = new Set(snapshots.map((snapshot) => Uri.from(snapshot.uri).toString()));
    for (const [key, document] of getTextDocuments(bridge)) {
      if (keys.has(key) || documentProviders.has(document)) continue;
      document.update({ ...document.toJSON(), isClosed: true });
      getTextDocuments(bridge).delete(key);
    }
    for (const snapshot of snapshots) reviveTextDocument(bridge, snapshot);
  });
  bridge.commandHandlers.set("__ws.onDidOpenTextDocument", (raw) => {
    const snapshot = raw as TextDocumentSnapshot;
    const known = getTextDocuments(bridge).has(Uri.from(snapshot.uri).toString());
    const document = reviveTextDocument(bridge, snapshot);
    if (!known) openDocEmitter.fire(document);
  });
  bridge.commandHandlers.set("__ws.onDidCloseTextDocument", (raw) => {
    const document = reviveTextDocument(bridge, raw as TextDocumentSnapshot);
    closeTextDocument(document);
  });
  bridge.commandHandlers.set("__ws.onDidSaveTextDocument", (raw) =>
    saveDocEmitter.fire(reviveTextDocument(bridge, raw as TextDocumentSnapshot)),
  );
  bridge.commandHandlers.set("__ws.onDidChangeTextDocument", (raw) => {
    const event = raw as {
      document: TextDocumentSnapshot;
      contentChanges: {
        range: { start: Position; end: Position };
        rangeOffset: number;
        rangeLength: number;
        text: string;
      }[];
      reason?: number;
    };
    changeDocEmitter.fire({
      ...event,
      document: reviveTextDocument(bridge, event.document),
      contentChanges: event.contentChanges.map((change) => ({
        ...change,
        range: new Range(
          new Position(change.range.start.line, change.range.start.character),
          new Position(change.range.end.line, change.range.end.character),
        ),
      })),
    });
  });
  bridge.commandHandlers.set("__ws.onDidChangeWorkspaceFolders", (raw) => {
    const event = raw as {
      added: Parameters<typeof decodeFolder>[0][];
      removed: Parameters<typeof decodeFolder>[0][];
      folders?: Parameters<typeof decodeFolder>[0][];
    };
    const added = event.added.map(decodeFolder);
    const removed = event.removed.map(decodeFolder);
    const removedUris = new Set(removed.map((folder) => folder.uri.toString()));
    const next = folders().filter((folder) => !removedUris.has(folder.uri.toString()));
    for (const folder of [...added].sort((a, b) => a.index - b.index))
      next.splice(folder.index, 0, folder);
    folderSnapshot = event.folders
      ? event.folders.map(decodeFolder)
      : next.map((folder, index) => ({ ...folder, index }));
    changeFoldersEmitter.fire({ added, removed });
  });
  bridge.commandHandlers.set("__ws.fileChanged", (event) => fileEmitter.fire(event as FileChange));

  const fileSearchRoots = () =>
    folders()
      .filter(({ uri }) => uri.scheme === "file")
      .map(({ uri }) => uri.fsPath);
  return {
    ...configuration,
    ...features,
    ...tunnels,
    get tunnels() {
      return tunnels.tunnels;
    },
    ...fileOperations,
    ...notebookNamespace,
    get notebookDocuments() {
      return notebooks.notebookDocuments;
    },
    get isTrusted() {
      return features.isTrusted;
    },
    registerFileSystemProvider: fileSystem.registerFileSystemProvider,
    registerTextDocumentContentProvider(scheme: string, provider: ContentProvider) {
      if (contentProviders.has(scheme))
        throw new Error(`Text document content provider already registered: ${scheme}`);
      const read: ContentReader = (uri, token) => provider.provideTextDocumentContent(uri, token);
      contentProviders.set(scheme, read);
      const subscription = provider.onDidChange?.((uri) => {
        const document = getTextDocuments(bridge).get(uri.toString());
        if (uri.scheme === scheme && document && documentProviders.get(document) === read)
          void refreshVirtualDocument(uri).catch(console.error);
      });
      return new Disposable(() => {
        contentProviders.delete(scheme);
        subscription?.dispose();
        for (const document of [...getTextDocuments(bridge).values()]) {
          if (document.uri.scheme !== scheme || documentProviders.get(document) !== read) continue;
          closeTextDocument(document);
          const viewId = virtualDocumentViewIds.get(document);
          if (viewId)
            void bridge.callMain("window.closeVirtualTextDocument", viewId).catch(console.error);
        }
      });
    },
    get workspaceFolders() {
      const current = folders();
      return current.length ? current : undefined;
    },
    get textDocuments() {
      return [...getTextDocuments(bridge).values()];
    },
    findFiles: async (
      include: GlobPattern,
      exclude?: GlobPattern | null,
      maxResults?: number,
      token?: SearchCancellationToken,
    ): Promise<Uri[]> => {
      const config = configuration.getConfiguration();
      return findWorkspaceFiles(
        fileSearchRoots(),
        [include],
        {
          exclude: exclude ? [exclude] : undefined,
          useExcludeSettings:
            exclude === null ? ExcludeSettingOptions.None : ExcludeSettingOptions.FilesExclude,
          useIgnoreFiles: {
            local:
              exclude === null ||
              !config.get("search.experimental.useIgnoreFilesInFindFiles", false)
                ? false
                : undefined,
          },
          maxResults,
        },
        config,
        token,
        bridge.getRequestSignal?.(),
      );
    },
    fs: fileSystem.fs,
    async findFiles2(
      patterns: readonly GlobPattern[],
      options?: FindFiles2Options,
      token?: SearchCancellationToken,
    ): Promise<Uri[]> {
      return findWorkspaceFiles(
        fileSearchRoots(),
        patterns,
        { ...options, maxResults: options?.maxResults ?? 20_000 },
        configuration.getConfiguration(),
        token,
        bridge.getRequestSignal?.(),
      );
    },
    async findTextInFiles(
      query: {
        pattern: string;
        isRegExp?: boolean;
        isCaseSensitive?: boolean;
        isWordMatch?: boolean;
      },
      optionsOrCallback: TextSearchOptions | ((result: TextSearchResult) => void),
      callbackOrToken?: ((result: TextSearchResult) => void) | CancellationToken,
      token?: CancellationToken,
    ): Promise<{ limitHit: boolean }> {
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : (callbackOrToken as (result: TextSearchResult) => void);
      const cancellation =
        typeof optionsOrCallback === "function"
          ? (callbackOrToken as CancellationToken | undefined)
          : token;
      if (cancellation?.isCancellationRequested) return { limitHit: false };
      const result = (await bridge.callMain("workspace.findTextInFiles", query, options)) as {
        hits: TextSearchHit[];
        limitHit: boolean;
      };
      for (const hit of result.hits) {
        if (cancellation?.isCancellationRequested) break;
        callback({
          uri: Uri.file(hit.path),
          ranges: new Range(new Position(hit.line, hit.start), new Position(hit.line, hit.end)),
          preview: {
            text: hit.text,
            matches: new Range(new Position(0, hit.start), new Position(0, hit.end)),
          },
        });
      }
      return { limitHit: result.limitHit };
    },
    async save(uri: Uri): Promise<Uri | undefined> {
      const result = (await bridge.callMain("workspace.save", uri.toJSON())) as
        | Parameters<typeof Uri.from>[0]
        | undefined;
      return result ? Uri.from(result) : undefined;
    },
    async saveAll(includeUntitled?: boolean): Promise<boolean> {
      return Boolean(await bridge.callMain("workspace.saveAll", includeUntitled ?? false));
    },
    onDidOpenTextDocument: openDocEmitter.event,
    onDidCloseTextDocument: closeDocEmitter.event,
    onDidSaveTextDocument: saveDocEmitter.event,
    onDidChangeTextDocument: changeDocEmitter.event,
    onDidChangeWorkspaceFolders: changeFoldersEmitter.event,
    async openTextDocument(uriOrPath: Uri | string) {
      const uri = typeof uriOrPath === "string" ? Uri.file(uriOrPath) : uriOrPath;
      if (uri?.scheme && !getTextDocuments(bridge).has(uri.toString())) {
        if (uri.scheme === "file") {
          void fileSystem.activateProvider(uri.scheme);
        } else if (!contentProviders.has(uri.scheme) && !fileSystem.hasProvider(uri.scheme)) {
          await fileSystem.activateProvider(uri.scheme);
        }
      }
      if (!uri?.scheme) throw new Error("Untitled text documents are not supported");
      const key = uri.toString();
      const known = getTextDocuments(bridge).get(key);
      if (known) return known;
      const source = documentSource(uri.scheme);
      const previous = documentOpens.get(key);
      if (previous && previous.source === source) return previous.promise;

      const pending = {
        source,
        promise: Promise.resolve().then(() => loadTextDocument(uri, source)),
      };
      documentOpens.set(key, pending);
      try {
        return await pending.promise;
      } finally {
        if (documentOpens.get(key) === pending) documentOpens.delete(key);
      }
    },
    createFileSystemWatcher(
      globPattern: GlobPattern,
      ignoreCreateEvents = false,
      ignoreChangeEvents = false,
      ignoreDeleteEvents = false,
    ) {
      const create = new EventEmitter<Uri>();
      const change = new EventEmitter<Uri>();
      const deleted = new EventEmitter<Uri>();
      const relativePattern = typeof globPattern === "string" ? undefined : globPattern;
      const base = relativePattern?.baseUri
        ? Uri.from(relativePattern.baseUri)
        : relativePattern?.base
          ? Uri.file(relativePattern.base)
          : undefined;
      const glob = typeof globPattern === "string" ? globPattern : globPattern.pattern;
      const match = picomatch(glob, { dot: true, windows: false });
      const matchIgnoringCase = picomatch(glob, { dot: true, nocase: true, windows: false });
      const recursive = glob.includes("**") || glob.includes("/");
      const ignoresAllEvents = ignoreCreateEvents && ignoreChangeEvents && ignoreDeleteEvents;
      const providerWatch =
        base && base.scheme !== "file" && !ignoresAllEvents
          ? fileSystem.watch(base, {
              recursive,
              excludes: recursive
                ? Object.entries(
                    configuration
                      .getConfiguration("files", base)
                      .get<Record<string, boolean>>("watcherExclude") ?? {},
                  )
                    .filter(([, excluded]) => excluded === true)
                    .map(([pattern]) => pattern)
                : [],
            })
          : undefined;
      const subscription = fileEmitter.event((event) => {
        const uri = event.uri ?? Uri.file(event.path);
        const caseSensitive = fileSystem.isPathCaseSensitive(uri.scheme);
        const matchesResource = (root: Uri) => {
          const relative = watcherRelativePath(root, uri, caseSensitive);
          if (relative === undefined) return false;
          if (relative === "") return glob === "*" || glob === "**";
          return (caseSensitive ? match : matchIgnoringCase)(relative);
        };
        const matches = relativePattern
          ? base && matchesResource(base)
          : folders().some((folder) => matchesResource(folder.uri));
        if (!matches) return;
        if (!ignoreCreateEvents && (event.type === "add" || event.type === "addDir"))
          create.fire(uri);
        else if (!ignoreChangeEvents && event.type === "change") change.fire(uri);
        else if (!ignoreDeleteEvents && (event.type === "unlink" || event.type === "unlinkDir"))
          deleted.fire(uri);
      });
      return {
        ignoreCreateEvents,
        ignoreChangeEvents,
        ignoreDeleteEvents,
        ignoresCreateEvents: ignoreCreateEvents,
        ignoresChangeEvents: ignoreChangeEvents,
        ignoresDeleteEvents: ignoreDeleteEvents,
        onDidCreate: create.event,
        onDidChange: change.event,
        onDidDelete: deleted.event,
        dispose() {
          subscription.dispose();
          providerWatch?.dispose();
          create.dispose();
          change.dispose();
          deleted.dispose();
        },
      };
    },
    asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder = folders().length > 1): string {
      // An exact workspace root is labelled relative to its containing root.
      const uri = typeof pathOrUri === "string" ? Uri.file(pathOrUri) : pathOrUri;
      const folder = containingFolder(uri, true);
      if (!folder) return typeof pathOrUri === "string" ? pathOrUri : uri.fsPath;
      const relative =
        uri.scheme === "file"
          ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/")
          : path.posix.relative(folder.uri.path || "/", uri.path || "/");
      return includeWorkspaceFolder && folder.name ? `${folder.name}/${relative}` : relative;
    },
    getWorkspaceFolder(uri: Uri) {
      return containingFolder(uri);
    },
  };
}
