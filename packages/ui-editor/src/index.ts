/// <reference path="./monaco-env.d.ts" />
import { inject } from "@harness/di";
import { inferLanguage } from "./language.ts";
import { Config, UiConfigService } from "@harness/ui-config";

export const FilesEolField = Config.defineField<string>("harness:ui-editor:files.eol");
export const EditorOptionsField = Config.defineField<Record<string, unknown>>(
  "harness:ui-editor:editor",
);
import { UiWorkspaceService, type WorkspaceWatchEvent } from "@harness/ui-workspace";
import type { editor, languages } from "monaco-editor";
import { reactive, ref, type Ref } from "vue";

export { ensureMonacoWorkers } from "./monaco-environment.ts";

export interface EditorDocument {
  readonly id: number;
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly name: string;
  language: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  size: number;
  loading: boolean;
  binary: boolean;
  tooLarge: boolean;
  externalDeleted: boolean;
  externalChanged: boolean;
  error?: string;
}

interface OpenEditorDocument extends EditorDocument {
  location: Pick<EditorDocument, "path" | "relativePath" | "name">;
}

export type LanguageResolver = (filePath: string, firstLine?: string) => string | undefined;
export type EditorMountHook = (path: string, editor: unknown) => (() => void) | void;
export type ModelEditListener = (
  document: EditorDocument,
  previousContent: string,
  event: editor.IModelContentChangedEvent,
) => void;

function normalizeJoin(root: string, relativePath: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const cleanRel = relativePath.replace(/^\/+/, "");
  return cleanRel ? `${cleanRoot}/${cleanRel}` : cleanRoot;
}

export class FileEditorService {
  private readonly openDocuments = reactive(new Map<string, OpenEditorDocument>());
  private readonly documentsById = reactive(new Map<number, OpenEditorDocument>());
  readonly documents: ReadonlyMap<string, EditorDocument> = this.openDocuments;
  readonly previewPath: Ref<string | null> = ref(null);

  private readonly workspace = inject(UiWorkspaceService);
  private readonly config = inject(UiConfigService);
  private readonly recentSaves = new Map<string, number>();
  private readonly writingPaths = new Map<string, Promise<void>>();
  private readonly languageResolvers = new Set<LanguageResolver>();
  private readonly editorHooks = new Set<EditorMountHook>();
  private readonly modelEditListeners = new Set<ModelEditListener>();
  private nextDocumentId = 0;
  private readonly editorViews = new Map<string, editor.IStandaloneCodeEditor>();

  constructor() {
    this.workspace.onFileChange((event) => {
      this.handleExternalChange(event);
    });
  }

  registerLanguageResolver(resolver: LanguageResolver): () => void {
    this.languageResolvers.add(resolver);
    this.refreshLanguages();
    return () => {
      this.languageResolvers.delete(resolver);
      this.refreshLanguages();
    };
  }

  refreshLanguages(): void {
    for (const doc of this.documents.values()) {
      doc.language = this.resolveLanguage(doc.path, doc.content.split(/\r?\n/, 1)[0]);
    }
  }

  resolveLanguage(filePath: string, firstLine = ""): string {
    for (const resolver of this.languageResolvers) {
      const resolved = resolver(filePath, firstLine);
      if (resolved) return resolved;
    }
    return inferLanguage(filePath, firstLine);
  }

  registerEditorHook(hook: EditorMountHook): () => void {
    this.editorHooks.add(hook);
    return () => {
      this.editorHooks.delete(hook);
    };
  }

  getEditorView(tabId: string): editor.IStandaloneCodeEditor | undefined {
    return this.editorViews.get(tabId);
  }

  async getDocumentSymbols(tabId: string): Promise<languages.DocumentSymbol[]> {
    const model = this.getEditorView(tabId)?.getModel();
    if (!model) return [];
    const [{ StandaloneServices }, { ICommandService }] = await Promise.all([
      import("monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js"),
      import("monaco-editor/esm/vs/platform/commands/common/commands.js"),
    ]);
    const commands = StandaloneServices.get(ICommandService) as {
      executeCommand<T>(id: string, ...args: unknown[]): Promise<T>;
    };
    return commands.executeCommand<languages.DocumentSymbol[]>(
      "_executeDocumentSymbolProvider", model.uri,
    );
  }

  notifyEditorMounted(
    path: string,
    editor: editor.IStandaloneCodeEditor,
    tabId: string,
  ): () => void {
    this.editorViews.set(tabId, editor);
    const cleanups: Array<() => void> = [];
    for (const hook of this.editorHooks) {
      const cleanup = hook(path, editor);
      if (cleanup) cleanups.push(cleanup);
    }
    return () => {
      if (this.editorViews.get(tabId) === editor) this.editorViews.delete(tabId);
      for (const cleanup of cleanups) cleanup();
    };
  }

  private handleExternalChange(event: WorkspaceWatchEvent): void {
    const doc = this.documents.get(event.path);
    if (!doc) return;

    if (event.type === "unlink") {
      doc.externalDeleted = true;
      return;
    }

    if (event.type === "change") {
      const lastSave = this.recentSaves.get(doc.path);
      if (lastSave !== undefined && Date.now() - lastSave < 500) {
        return;
      }
      if (doc.content === doc.savedContent) {
        void this.reloadDocument(doc.path);
      } else {
        doc.externalChanged = true;
      }
    }
  }

  getDocument(path: string): EditorDocument | undefined {
    return this.documents.get(path);
  }

  getDocumentById(id: number): EditorDocument | undefined {
    return this.documentsById.get(id);
  }

  isDirty(pathOrDocument: string | EditorDocument): boolean {
    const doc =
      typeof pathOrDocument === "string" ? this.documents.get(pathOrDocument) : pathOrDocument;
    if (!doc || doc.binary || doc.tooLarge) return false;
    return doc.content !== doc.savedContent;
  }

  async openDocument(
    root: string,
    relativePath: string,
    options?: { preview?: boolean },
  ): Promise<EditorDocument> {
    const fullPath = normalizeJoin(root, relativePath);
    const pendingWrite = this.writingPaths.get(fullPath);
    if (!this.documents.has(fullPath) && pendingWrite) {
      await pendingWrite.catch(() => undefined);
    }
    const existing = this.documents.get(fullPath);
    if (existing) {
      if (options?.preview === false && this.previewPath.value === fullPath) {
        this.previewPath.value = null;
      }
      return existing;
    }

    const name = relativePath.split("/").at(-1) ?? relativePath;
    const doc = reactive<OpenEditorDocument>({
      id: ++this.nextDocumentId,
      root,
      location: { path: fullPath, relativePath, name },
      get path() {
        return this.location.path;
      },
      get relativePath() {
        return this.location.relativePath;
      },
      get name() {
        return this.location.name;
      },
      language: this.resolveLanguage(relativePath),
      content: "",
      savedContent: "",
      mtimeMs: 0,
      size: 0,
      loading: true,
      binary: false,
      tooLarge: false,
      externalDeleted: false,
      externalChanged: false,
    });
    this.openDocuments.set(fullPath, doc);
    this.documentsById.set(doc.id, doc);

    if (options?.preview) {
      this.previewPath.value = fullPath;
    }

    await this.fetchIntoDocument(doc);
    return doc;
  }

  private async fetchIntoDocument(doc: EditorDocument): Promise<void> {
    doc.loading = true;
    doc.error = undefined;
    try {
      const rootService = this.workspace.getRoot(doc.root);
      const result = await rootService.readFile(doc.relativePath);
      doc.content = result.content;
      doc.language = this.resolveLanguage(doc.path, result.content.split(/\r?\n/, 1)[0]);
      doc.savedContent = result.content;
      doc.mtimeMs = result.mtimeMs;
      doc.size = result.size;
      doc.binary = result.binary;
      doc.tooLarge = result.tooLarge;
      doc.externalDeleted = false;
      doc.externalChanged = false;
    } catch (error) {
      doc.error = error instanceof Error ? error.message : String(error);
    } finally {
      doc.loading = false;
    }
  }

  onDidEditContent(listener: ModelEditListener): () => void {
    this.modelEditListeners.add(listener);
    return () => this.modelEditListeners.delete(listener);
  }

  updateContent(path: string, content: string, event?: editor.IModelContentChangedEvent): void {
    const doc = this.documents.get(path);
    if (!doc) return;
    const previousContent = doc.content;
    doc.content = content;
    if (this.previewPath.value === path) {
      this.previewPath.value = null;
    }
    if (event && previousContent !== content) {
      for (const listener of this.modelEditListeners) listener(doc, previousContent, event);
    }
  }

  pinDocument(path: string): void {
    if (this.previewPath.value === path) {
      this.previewPath.value = null;
    }
  }

  async saveDocument(path: string): Promise<void> {
    const doc = this.documents.get(path);
    if (!doc || doc.binary || doc.tooLarge) return;
    await this.writePaths([path], async () => {
      const originalContent = doc.content;
      const eol = this.config.get(FilesEolField) ?? "auto";
      const content =
        eol === "\n" || eol === "\r\n"
          ? originalContent.replace(/\r\n|\r|\n/g, eol)
          : originalContent;
      this.recentSaves.set(path, Date.now());
      const result = await this.workspace
        .getRoot(doc.root)
        .writeFile(doc.relativePath, content, doc.mtimeMs || undefined);
      if (doc.content === originalContent) doc.content = content;
      doc.savedContent = content;
      doc.mtimeMs = result.mtimeMs;
      doc.size = result.size;
      doc.externalDeleted = false;
      doc.externalChanged = false;
      this.pinDocument(path);
    });
  }

  async renameDocument(
    root: string,
    oldRelativePath: string,
    newRelativePath: string,
  ): Promise<void> {
    const oldPath = normalizeJoin(root, oldRelativePath);
    const newPath = normalizeJoin(root, newRelativePath);
    if (oldPath === newPath) return;
    await this.writePaths([oldPath, newPath], async () => {
      if (this.documents.has(newPath)) throw new Error("The destination is already open");
      if (this.documents.get(oldPath)?.loading) throw new Error("The file is still loading");

      await this.workspace.getRoot(root).renamePath(oldRelativePath, newRelativePath);
      const doc = this.openDocuments.get(oldPath);
      if (!doc) return;

      const name = newRelativePath.split("/").at(-1) ?? newRelativePath;
      this.openDocuments.set(newPath, doc);
      doc.location = { path: newPath, relativePath: newRelativePath, name };
      this.openDocuments.delete(oldPath);
      doc.language = this.resolveLanguage(newPath, doc.content.split(/\r?\n/, 1)[0]);
      doc.externalDeleted = false;
      if (this.previewPath.value === oldPath) this.previewPath.value = newPath;
      this.recentSaves.delete(oldPath);
    });
  }

  private async writePaths(paths: readonly string[], write: () => Promise<void>): Promise<void> {
    if (paths.some((path) => this.writingPaths.has(path))) {
      throw new Error("A file operation is already in progress");
    }
    const pending = Promise.resolve().then(write);
    for (const path of paths) this.writingPaths.set(path, pending);
    try {
      await pending;
    } finally {
      for (const path of paths) this.writingPaths.delete(path);
    }
  }

  async reloadDocument(path: string): Promise<void> {
    if (this.writingPaths.has(path)) return;
    const doc = this.documents.get(path);
    if (!doc) return;
    await this.fetchIntoDocument(doc);
  }

  closeDocument(path: string): void {
    const doc = this.openDocuments.get(path);
    if (doc) {
      this.openDocuments.delete(path);
      this.documentsById.delete(doc.id);
    }
    if (this.previewPath.value === path) {
      this.previewPath.value = null;
    }
  }
}

export { inferLanguage } from "./language.ts";
export { default as FileEditorView } from "./components/FileEditorView.vue";
export { FileEditorTabDescriptor, openFileEditorTab } from "./tabs/FileEditorTab.ts";
