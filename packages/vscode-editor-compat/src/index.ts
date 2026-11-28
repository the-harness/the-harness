import { inject } from "@harness/di";
import { FileEditorService, type EditorDocument } from "@harness/ui-editor";
import { UiWorkspaceService } from "@harness/ui-workspace";
import {
  EventEmitter,
  FileSystemError,
  Position,
  Range,
  TextDocumentChangeReason,
  TextDocumentData,
  Uri,
  type TextDocumentSnapshot,
} from "@harness/vscode-types";
import { computed, onScopeDispose, watch, type ComputedRef } from "vue";

export {
  Disposable,
  EventEmitter,
  Position,
  Range,
  Selection,
  Uri,
  type Event,
} from "@harness/vscode-types";
export type { TextDocumentSnapshot } from "@harness/vscode-types";

export { VscodeCommandsCompatService, VscodeEnvCompatService } from "./commands-env.ts";
export {
  CompletionItem,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  VscodeLanguagesCompatService,
  type DiagnosticCollection,
  type SemanticTokensQuery,
  type DocumentSelector,
  type FormattingQuery,
} from "./languages.ts";
export {
  TextEditor,
  VscodeWindowCompatService,
  type DecorationRenderOptions,
  type TextEditorDecorationType,
  type TextEditorEdit,
  type TextDocumentShowOptions,
  type DecorationOptions,
} from "./window.ts";

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[];
  readonly removed: readonly WorkspaceFolder[];
}

export interface TextDocumentChangeEvent {
  readonly document: TextDocument;
  readonly reason?: TextDocumentChangeReason;
  readonly contentChanges: readonly {
    readonly range: Range;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[];
}

function snapshotOf(doc: EditorDocument, version: number, closed = false): TextDocumentSnapshot {
  return {
    uri: Uri.file(doc.path).toJSON(),
    text: doc.content,
    version,
    languageId: doc.language,
    isDirty: doc.content !== doc.savedContent,
    eol: doc.content.includes("\r\n") ? 2 : 1,
    encoding: "utf8",
    isClosed: closed,
  };
}

export class TextDocument extends TextDocumentData {
  constructor(
    private readonly doc: EditorDocument,
    editorService: FileEditorService,
  ) {
    const path = doc.path;
    super(snapshotOf(doc, 1), async () => {
      if (
        doc.loading ||
        doc.error ||
        doc.binary ||
        doc.tooLarge ||
        doc.path !== path ||
        editorService.getDocument(path) !== doc
      )
        return false;
      try {
        await editorService.saveDocument(path);
        return true;
      } catch {
        return false;
      }
    });
  }

  refresh(closed = false): void {
    const version =
      this.version +
      (this.getText() !== this.doc.content || this.languageId !== this.doc.language ? 1 : 0);
    this.update(snapshotOf(this.doc, version, closed));
  }
}

export class VscodeWorkspaceCompatService {
  private readonly workspace = inject(UiWorkspaceService);
  private readonly editorService = inject(FileEditorService);
  private readonly documents = new Map<
    string,
    { source: EditorDocument; document: TextDocument }
  >();
  private readonly foldersChangeEmitter = new EventEmitter<WorkspaceFoldersChangeEvent>();
  private readonly openDocEmitter = new EventEmitter<TextDocument>();
  private readonly changeDocEmitter = new EventEmitter<TextDocumentChangeEvent>();
  private readonly saveDocEmitter = new EventEmitter<TextDocument>();
  private readonly closeDocEmitter = new EventEmitter<TextDocument>();

  readonly onDidChangeWorkspaceFolders = this.foldersChangeEmitter.event;
  readonly onDidOpenTextDocument = this.openDocEmitter.event;
  readonly onDidChangeTextDocument = this.changeDocEmitter.event;
  readonly onDidSaveTextDocument = this.saveDocEmitter.event;
  readonly onDidCloseTextDocument = this.closeDocEmitter.event;

  readonly workspaceFolders: ComputedRef<readonly WorkspaceFolder[]> = computed(() =>
    this.workspace.activeRoots.value.map((root, index) => ({
      uri: Uri.file(root),
      name: root.split("/").filter(Boolean).at(-1) ?? root,
      index,
    })),
  );

  readonly textDocuments: ComputedRef<readonly TextDocument[]> = computed(() =>
    Array.from(this.editorService.documents.values())
      .filter((doc) => !doc.loading && !doc.error && !doc.binary && !doc.tooLarge)
      .map((doc) => this.wrapDocument(doc)),
  );

  constructor() {
    const stopRootsWatch = watch(
      () => this.workspaceFolders.value,
      (next, prev) => {
        const nextUris = new Set(next.map((folder) => folder.uri.toString()));
        const prevUris = new Set(prev.map((folder) => folder.uri.toString()));
        const added = next.filter((folder) => !prevUris.has(folder.uri.toString()));
        const removed = prev.filter((folder) => !nextUris.has(folder.uri.toString()));
        if (added.length || removed.length) this.foldersChangeEmitter.fire({ added, removed });
      },
    );
    const known = new Map<
      string,
      { text: string; mtimeMs: number; saved: string; document: TextDocument }
    >();
    const stopDocsWatch = watch(
      () =>
        Array.from(this.editorService.documents.values()).map((doc) => ({
          doc,
          content: doc.content,
          saved: doc.savedContent,
          mtimeMs: doc.mtimeMs,
          loading: doc.loading,
          error: doc.error,
          binary: doc.binary,
          tooLarge: doc.tooLarge,
        })),
      (items) => {
        const paths = new Set(items.map(({ doc }) => doc.path));
        for (const item of items) {
          if (item.loading || item.error || item.binary || item.tooLarge) continue;
          const previous = known.get(item.doc.path);
          const document = this.wrapDocument(item.doc);
          if (!previous) {
            known.set(item.doc.path, {
              text: item.content,
              mtimeMs: item.mtimeMs,
              saved: item.saved,
              document,
            });
            this.openDocEmitter.fire(document);
            continue;
          }
          if (previous.text !== item.content) {
            const old = new TextDocumentData({ ...document.toJSON(), text: previous.text });
            this.changeDocEmitter.fire({
              document,
              contentChanges: [
                {
                  range: new Range(new Position(0, 0), old.positionAt(previous.text.length)),
                  rangeOffset: 0,
                  rangeLength: previous.text.length,
                  text: item.content,
                },
              ],
            });
          } else if ((previous.text !== previous.saved) !== (item.content !== item.saved)) {
            this.changeDocEmitter.fire({ document, contentChanges: [] });
          }
          if (
            (previous.saved !== item.saved || previous.mtimeMs !== item.mtimeMs) &&
            item.content === item.saved
          ) {
            this.saveDocEmitter.fire(document);
          }
          known.set(item.doc.path, {
            text: item.content,
            mtimeMs: item.mtimeMs,
            saved: item.saved,
            document,
          });
        }
        for (const [path, previous] of known) {
          if (paths.has(path)) continue;
          previous.document.refresh(true);
          this.closeDocEmitter.fire(previous.document);
          known.delete(path);
          this.documents.delete(path);
        }
      },
      { immediate: true },
    );
    const stopModelEdits = this.editorService.onDidEditContent((source, previousContent, event) => {
      const previous = known.get(source.path);
      if (!previous || previous.text !== previousContent) return;
      const document = this.wrapDocument(source);
      if (document !== previous.document) return;
      previous.text = source.content;
      this.changeDocEmitter.fire({
        document,
        contentChanges: event.changes.map(({ range, rangeOffset, rangeLength, text }) => ({
          range: new Range(
            range.startLineNumber - 1,
            range.startColumn - 1,
            range.endLineNumber - 1,
            range.endColumn - 1,
          ),
          rangeOffset,
          rangeLength,
          text,
        })),
        reason: event.isUndoing
          ? TextDocumentChangeReason.Undo
          : event.isRedoing
            ? TextDocumentChangeReason.Redo
            : undefined,
      });
    });
    onScopeDispose(() => {
      stopRootsWatch();
      stopDocsWatch();
      stopModelEdits();
      known.clear();
      this.documents.clear();
      this.foldersChangeEmitter.dispose();
      this.openDocEmitter.dispose();
      this.changeDocEmitter.dispose();
      this.saveDocEmitter.dispose();
      this.closeDocEmitter.dispose();
    });
  }

  private wrapDocument(source: EditorDocument): TextDocument {
    let entry = this.documents.get(source.path);
    if (!entry || entry.source !== source) {
      entry = { source, document: new TextDocument(source, this.editorService) };
      this.documents.set(source.path, entry);
    }
    entry.document.refresh();
    return entry.document;
  }

  getTextDocument(path: string): TextDocument | undefined {
    const doc = this.editorService.getDocument(path);
    return doc ? this.wrapDocument(doc) : undefined;
  }

  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return [...this.workspaceFolders.value]
      .sort((a, b) => b.uri.path.length - a.uri.path.length)
      .find((folder) => {
        if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority)
          return false;
        const root = folder.uri.path.replace(/\/+$/, "");
        return uri.path === root || uri.path.startsWith(`${root}/`);
      });
  }

  asRelativePath(
    pathOrUri: string | Uri,
    includeWorkspaceFolder = this.workspaceFolders.value.length > 1,
  ): string {
    const uri = typeof pathOrUri === "string" ? Uri.file(pathOrUri) : pathOrUri;
    const folder = this.getWorkspaceFolder(uri);
    if (!folder) return typeof pathOrUri === "string" ? pathOrUri : uri.fsPath;
    const relative = uri.path.slice(folder.uri.path.replace(/\/+$/, "").length).replace(/^\//, "");
    return includeWorkspaceFolder ? `${folder.name}${relative ? `/${relative}` : ""}` : relative;
  }

  resolveDocumentLanguage(path: string, firstLine: string): string {
    return this.editorService.resolveLanguage(path, firstLine);
  }

  async openTextDocument(uriOrPath: Uri | string): Promise<TextDocument> {
    const uri = typeof uriOrPath === "string" ? Uri.file(uriOrPath) : uriOrPath;
    const folder = this.getWorkspaceFolder(uri);
    if (!folder)
      throw FileSystemError.NoPermissions(`Path is outside active workspace roots: ${uri.fsPath}`);
    const relativePath = this.asRelativePath(uri, false);
    const doc = await this.editorService.openDocument(folder.uri.fsPath, relativePath);
    if (doc.error) throw new Error(doc.error);
    if (doc.binary || doc.tooLarge) throw new Error(`Cannot open text document: ${uri.fsPath}`);
    return this.wrapDocument(doc);
  }

  renameDocument(root: string, oldRelativePath: string, newRelativePath: string): Promise<void> {
    return this.editorService.renameDocument(root, oldRelativePath, newRelativePath);
  }

  async applyEdit(
    entries: readonly [Uri, readonly { range: Range; newText: string }[]][],
  ): Promise<boolean> {
    const pending: { document: TextDocument; version: number; content: string }[] = [];
    try {
      for (const [uri, edits] of entries) {
        const document = await this.openTextDocument(uri);
        const values = edits
          .map((edit, index) => ({
            start: document.offsetAt(edit.range.start),
            end: document.offsetAt(edit.range.end),
            text: edit.newText,
            index,
          }))
          .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
        for (let i = 1; i < values.length; i++) {
          if (values[i]!.start < values[i - 1]!.end) return false;
        }
        let content = document.getText();
        for (const edit of values.reverse())
          content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
        pending.push({ document, version: document.version, content });
      }
    } catch {
      return false;
    }
    for (const item of pending) {
      if (this.getTextDocument(item.document.fileName)?.version !== item.version) return false;
    }
    for (const item of pending)
      this.editorService.updateContent(item.document.fileName, item.content);
    return true;
  }

  readonly fs = {
    readFile: async (uri: Uri): Promise<Uint8Array> => {
      const folder = this.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`Path is outside workspace: ${uri.path}`);
      const rel = this.asRelativePath(uri, false);
      const res = await this.workspace.getRoot(folder.uri.path).readFile(rel);
      if (res.tooLarge) throw new Error(`File is too large: ${uri.fsPath}`);
      return res.encoding === "base64"
        ? Uint8Array.from(atob(res.content), (character) => character.charCodeAt(0))
        : new TextEncoder().encode(res.content);
    },
    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
      const folder = this.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`Path is outside workspace: ${uri.path}`);
      const rel = this.asRelativePath(uri, false);
      await this.workspace
        .getRoot(folder.uri.path)
        .writeFile(rel, new TextDecoder("utf-8", { fatal: true }).decode(content));
    },
    readDirectory: async (uri: Uri): Promise<[string, number][]> => {
      const folder = this.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`Path is outside workspace: ${uri.path}`);
      const rel = this.asRelativePath(uri, false);
      const res = await this.workspace.getRoot(folder.uri.path).loadDir(rel);
      return res.entries.map((entry) => [entry.name, entry.type === "directory" ? 2 : 1]);
    },
    createDirectory: async (uri: Uri): Promise<void> => {
      const folder = this.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`Path is outside workspace: ${uri.path}`);
      const rel = this.asRelativePath(uri, false);
      await this.workspace.getRoot(folder.uri.path).createDir(rel);
    },
    delete: async (uri: Uri): Promise<void> => {
      const folder = this.getWorkspaceFolder(uri);
      if (!folder) throw new Error(`Path is outside workspace: ${uri.path}`);
      const rel = this.asRelativePath(uri, false);
      await this.workspace.getRoot(folder.uri.path).deletePath(rel);
    },
    rename: async (source: Uri, target: Uri): Promise<void> => {
      const folder = this.getWorkspaceFolder(source);
      if (!folder) throw new Error(`Path is outside workspace: ${source.path}`);
      const targetFolder = this.getWorkspaceFolder(target);
      if (folder.uri.toString() !== targetFolder?.uri.toString()) {
        throw new Error("Renaming across workspace roots is not supported");
      }
      await this.renameDocument(
        folder.uri.fsPath,
        this.asRelativePath(source, false),
        this.asRelativePath(target, false),
      );
    },
  };
}
