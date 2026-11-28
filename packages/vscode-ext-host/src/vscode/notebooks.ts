import { basename, matchesGlob } from "node:path";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  NotebookCellData,
  NotebookData,
  NotebookRange,
  Position,
  Range,
  TextDocumentData,
  Uri,
  type NotebookCellOutput,
  type NotebookEdit,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import type { createFileSystemApi } from "./file-system.ts";
import { reviveTextDocument } from "./document.ts";

type Serializer = {
  deserializeNotebook(
    content: Uint8Array,
    token: CancellationTokenSource["token"],
  ): NotebookData | PromiseLike<NotebookData>;
  serializeNotebook(
    data: NotebookData,
    token: CancellationTokenSource["token"],
  ): Uint8Array | PromiseLike<Uint8Array>;
};
type Cell = {
  readonly index: number;
  notebook: Notebook;
  kind: NotebookCellData["kind"];
  document: TextDocumentData;
  metadata: Record<string, unknown>;
  outputs: NotebookCellOutput[];
  executionSummary?: NotebookCellData["executionSummary"];
};
type Notebook = {
  uri: Uri;
  notebookType: string;
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  readonly isUntitled: boolean;
  metadata: Record<string, unknown>;
  readonly cellCount: number;
  cellAt(index: number): Cell;
  getCells(range?: NotebookRange): Cell[];
  save(): Promise<boolean>;
};
type Change = {
  notebook: Notebook;
  metadata?: Record<string, unknown>;
  contentChanges: { range: NotebookRange; addedCells: Cell[]; removedCells: Cell[] }[];
  cellChanges: {
    cell: Cell;
    document?: TextDocumentData;
    metadata?: Record<string, unknown>;
    outputs?: NotebookCellOutput[];
  }[];
};
type Contribution = {
  type: string;
  selector?: { filenamePattern: string; excludeFileNamePattern?: string }[];
};
type ContentOptions = {
  transientOutputs?: boolean;
  transientCellMetadata?: Record<string, boolean>;
  transientDocumentMetadata?: Record<string, boolean>;
};
const registries = new WeakMap<ExtHostBridge, Map<string, Notebook>>();
export function getNotebookForCell(bridge: ExtHostBridge, uri: Uri): Notebook | undefined {
  return [...(registries.get(bridge)?.values() ?? [])].find((notebook) =>
    notebook.getCells().some((cell) => cell.document.uri.toString() === uri.toString()),
  );
}

export function createNotebookApi(
  bridge: ExtHostBridge,
  fs: ReturnType<typeof createFileSystemApi>["fs"],
) {
  const serializers = new Map<string, { serializer: Serializer; options?: ContentOptions }>();
  const documents = new Map<string, Notebook>();
  registries.set(bridge, documents);
  const opened = new EventEmitter<Notebook>();
  const closed = new EventEmitter<Notebook>();
  const changed = new EventEmitter<Change>();
  const saved = new EventEmitter<Notebook>();
  const willSave = new EventEmitter<{
    notebook: Notebook;
    reason: number;
    waitUntil(value: PromiseLike<unknown>): void;
  }>();
  let contributions: Contribution[] = [];
  let cellHandle = 0;
  let untitledHandle = 0;
  bridge.commandHandlers.set("__notebooks.syncTypes", (value) => {
    contributions = value as Contribution[];
  });
  const change = (event: Change) => {
    event.notebook.version++;
    event.notebook.isDirty = true;
    changed.fire(event);
  };
  const closeCell = (cell: Cell) =>
    bridge.commandHandlers.get("__ws.onDidCloseTextDocument")?.(cell.document.toJSON());
  bridge.commandHandlers.set("__notebooks.close", (raw) => {
    const uri = Uri.revive(raw as Uri),
      document = documents.get(uri.toString());
    if (!document) return;
    document.isClosed = true;
    documents.delete(uri.toString());
    for (const cell of document.getCells()) closeCell(cell);
    closed.fire(document);
  });
  function makeCell(notebook: Notebook, data: NotebookCellData): Cell {
    const uri = notebook.uri.with({
      scheme: "vscode-notebook-cell",
      fragment: String(++cellHandle),
    });
    const snapshot = {
      uri: uri.toJSON(),
      text: data.value,
      languageId: data.languageId,
      version: 1,
      eol: data.value.includes("\r\n") ? (2 as const) : (1 as const),
      isDirty: false,
    };
    const document = new TextDocumentData(snapshot);
    return {
      get index() {
        return notebook.getCells().indexOf(this);
      },
      notebook,
      kind: data.kind,
      document,
      metadata: data.metadata ?? {},
      outputs: data.outputs ?? [],
      executionSummary: data.executionSummary,
    };
  }
  function announceCell(cell: Cell): void {
    const snapshot = cell.document.toJSON();
    bridge.commandHandlers.get("__ws.onDidOpenTextDocument")?.(snapshot);
    cell.document = reviveTextDocument(bridge, snapshot);
  }
  function createDocument(uri: Uri, notebookType: string, data: NotebookData): Notebook {
    let cells: Cell[] = [];
    const notebook: Notebook = {
      uri,
      notebookType,
      version: 1,
      isDirty: false,
      isClosed: false,
      metadata: data.metadata ?? {},
      get isUntitled() {
        return uri.scheme === "untitled";
      },
      get cellCount() {
        return cells.length;
      },
      cellAt(index) {
        if (!Number.isInteger(index) || index < 0 || index >= cells.length)
          throw new RangeError("Notebook cell index is out of range");
        return cells[index]!;
      },
      getCells(range) {
        return range ? cells.slice(range.start, range.end) : [...cells];
      },
      async save() {
        if (notebook.isClosed || notebook.isUntitled) return false;
        const registration = serializers.get(notebookType);
        if (!registration) return false;
        const { serializer, options } = registration;
        const source = new CancellationTokenSource();
        try {
          const pending: PromiseLike<unknown>[] = [];
          let accepting = true;
          willSave.fire({
            notebook,
            reason: 1,
            waitUntil(value) {
              if (!accepting) throw new Error("waitUntil must be called during notebook save");
              pending.push(value);
            },
          });
          accepting = false;
          await Promise.all(pending);
          const value = new NotebookData(
            cells.map((cell) => {
              const data = new NotebookCellData(
                cell.kind,
                cell.document.getText(),
                cell.document.languageId,
              );
              data.metadata = Object.fromEntries(
                Object.entries(cell.metadata).filter(
                  ([key]) => !options?.transientCellMetadata?.[key],
                ),
              );
              data.outputs = options?.transientOutputs ? [] : cell.outputs;
              data.executionSummary = cell.executionSummary;
              return data;
            }),
          );
          value.metadata = Object.fromEntries(
            Object.entries(notebook.metadata).filter(
              ([key]) => !options?.transientDocumentMetadata?.[key],
            ),
          );
          const version = notebook.version;
          await fs.writeFile(uri, await serializer.serializeNotebook(value, source.token));
          if (notebook.version === version) {
            notebook.isDirty = false;
            for (const cell of cells)
              cell.document.update({ ...cell.document.toJSON(), isDirty: false });
          }
          saved.fire(notebook);
          return true;
        } catch (error) {
          console.error(error);
          return false;
        } finally {
          source.dispose();
        }
      },
    };
    cells = data.cells.map((cell) => makeCell(notebook, cell));
    documents.set(uri.toString(), notebook);
    editFunctions.set(notebook, (edit) => {
      const event: Change = { notebook, contentChanges: [], cellChanges: [] };
      if (edit.newNotebookMetadata !== undefined) {
        notebook.metadata = edit.newNotebookMetadata;
        event.metadata = notebook.metadata;
      } else if (edit.newCellMetadata !== undefined) {
        const cell = notebook.cellAt(edit.range.start);
        cell.metadata = edit.newCellMetadata;
        event.cellChanges.push({ cell, metadata: cell.metadata });
      } else {
        if (edit.range.start > cells.length || edit.range.end > cells.length) return false;
        const addedCells = edit.newCells.map((cell) => makeCell(notebook, cell));
        const removedCells = cells.splice(
          edit.range.start,
          edit.range.end - edit.range.start,
          ...addedCells,
        );
        for (const cell of removedCells) closeCell(cell);
        for (const cell of addedCells) announceCell(cell);
        event.contentChanges.push({ range: edit.range, addedCells, removedCells });
      }
      change(event);
      return true;
    });
    for (const cell of cells) announceCell(cell);
    opened.fire(notebook);
    return notebook;
  }
  const editFunctions = new WeakMap<Notebook, (edit: NotebookEdit) => boolean>();
  return {
    get notebookDocuments() {
      return [...documents.values()];
    },
    onDidOpenNotebookDocument: opened.event,
    onDidCloseNotebookDocument: closed.event,
    onDidChangeNotebookDocument: changed.event,
    onDidSaveNotebookDocument: saved.event,
    onWillSaveNotebookDocument: willSave.event,
    registerNotebookSerializer(type: string, serializer: Serializer, options?: ContentOptions) {
      if (serializers.has(type)) throw new Error(`Notebook serializer already registered: ${type}`);
      const entry = { serializer, options };
      serializers.set(type, entry);
      return new Disposable(() => {
        if (serializers.get(type) === entry) serializers.delete(type);
      });
    },
    async openNotebookDocument(
      uriOrType: Uri | string,
      initialData?: NotebookData,
    ): Promise<Notebook> {
      const uri =
        typeof uriOrType === "string"
          ? Uri.from({ scheme: "untitled", path: `Untitled-${++untitledHandle}` })
          : uriOrType;
      const known = documents.get(uri.toString());
      if (known) return known;
      const matches = (pattern: string) =>
        matchesGlob(pattern.includes("/") ? uri.path : basename(uri.path), pattern);
      const notebookType =
        typeof uriOrType === "string"
          ? uriOrType
          : contributions.find((item) =>
              item.selector?.some(
                (selector) =>
                  matches(selector.filenamePattern) &&
                  (!selector.excludeFileNamePattern || !matches(selector.excludeFileNamePattern)),
              ),
            )?.type;
      if (!notebookType) throw new Error(`No notebook type is registered for ${uri}`);
      if (!serializers.has(notebookType)) {
        await bridge.activateByEvent?.(`onNotebook:${notebookType}`);
        await bridge.activateByEvent?.(`onNotebookSerializer:${notebookType}`);
      }
      const serializer = serializers.get(notebookType)?.serializer;
      if (!serializer) throw new Error(`No notebook serializer registered: ${notebookType}`);
      const source = new CancellationTokenSource();
      try {
        return createDocument(
          uri,
          notebookType,
          initialData ??
            (await serializer.deserializeNotebook(
              typeof uriOrType === "string" ? new Uint8Array() : await fs.readFile(uri),
              source.token,
            )),
        );
      } finally {
        source.dispose();
      }
    },
    applyNotebookEdit(uri: Uri, edit: NotebookEdit): boolean {
      const notebook = documents.get(uri.toString());
      if (!notebook || notebook.isClosed) return false;
      return editFunctions.get(notebook)!(edit);
    },
    applyCellTextEdits(
      uri: Uri,
      edits: readonly { range: Range; newText: string }[],
    ): boolean | undefined {
      if (uri.scheme !== "vscode-notebook-cell") return undefined;
      const cell = [...documents.values()]
        .flatMap((document) => document.getCells())
        .find((cell) => cell.document.uri.toString() === uri.toString());
      if (!cell) return false;
      const document = cell.document,
        oldText = document.getText();
      const changes = edits
        .map((edit) => ({
          start: document.offsetAt(edit.range.start),
          end: document.offsetAt(edit.range.end),
          text: edit.newText,
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      if (changes.some((value, index) => index > 0 && value.start < changes[index - 1]!.end))
        return false;
      let text = oldText;
      for (const edit of changes.reverse())
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      bridge.commandHandlers.get("__ws.onDidChangeTextDocument")?.({
        document: { ...document.toJSON(), text, version: document.version + 1, isDirty: true },
        contentChanges: [
          {
            range: new Range(new Position(0, 0), document.positionAt(oldText.length)),
            rangeOffset: 0,
            rangeLength: oldText.length,
            text,
          },
        ],
      });
      change({ notebook: cell.notebook, cellChanges: [{ cell, document }], contentChanges: [] });
      return true;
    },
  };
}
