import {
  Position,
  Range,
  Selection,
  Uri,
  type ResolvedTextEditorOptions,
  type SnippetString,
  type TextDocumentSnapshot,
  type TextEditorOptions,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import { reviveTextDocument } from "./document.ts";
import { createLiveEditorOptions } from "./editor-options.ts";

export interface EditorSnapshot {
  document: TextDocumentSnapshot;
  selections: Selection[];
  visibleRanges: Range[];
  viewColumn?: number;
  options: Partial<ResolvedTextEditorOptions>;
  diffInformation?: {
    documentVersion: number;
    original?: ReturnType<Uri["toJSON"]>;
    modified: ReturnType<Uri["toJSON"]>;
    changes: readonly {
      original: { startLineNumber: number; endLineNumberExclusive: number };
      modified: { startLineNumber: number; endLineNumberExclusive: number };
      kind: number;
    }[];
    isStale: boolean;
  }[];
}

export interface EditorEditBuilder {
  replace(location: Range | Position, value: string): void;
  insert(location: Position, value: string): void;
  delete(location: Range): void;
  setEndOfLine(value: 1 | 2): void;
}

export class HostTextEditor {
  readonly document;
  private readonly bridge: ExtHostBridge;
  private snapshot: EditorSnapshot;
  private readonly liveOptions = createLiveEditorOptions(
    () => this.snapshot.options,
    (value) => this.applyOptions(value),
  );
  constructor(bridge: ExtHostBridge, snapshot: EditorSnapshot) {
    this.bridge = bridge;
    this.snapshot = snapshot;
    this.document = reviveTextDocument(bridge, snapshot.document);
  }
  update(snapshot: EditorSnapshot): void {
    this.snapshot = snapshot;
    reviveTextDocument(this.bridge, snapshot.document);
  }
  get selections(): Selection[] {
    return this.snapshot.selections.map((value) => new Selection(value.anchor, value.active));
  }
  set selections(values: readonly Selection[]) {
    if (
      !values.length ||
      values.some(
        (value) => !Position.isPosition(value.anchor) || !Position.isPosition(value.active),
      )
    )
      throw new Error("Invalid selections");
    this.snapshot.selections = values.map((value) => new Selection(value.anchor, value.active));
    void this.bridge.callMain(
      "editor.setSelections",
      this.document.uri.toJSON(),
      this.snapshot.selections,
    );
  }
  get selection(): Selection {
    return this.selections[0] ?? new Selection(0, 0, 0, 0);
  }
  set selection(value: Selection) {
    this.selections = [value];
  }
  get visibleRanges(): Range[] {
    return this.snapshot.visibleRanges.map(Range.of);
  }
  get viewColumn(): number | undefined {
    return this.snapshot.viewColumn;
  }
  get diffInformation() {
    return this.snapshot.diffInformation?.map((info) => ({
      ...info,
      original: info.original ? Uri.from(info.original) : undefined,
      modified: Uri.from(info.modified),
      changes: info.changes.map((change) => ({
        ...change,
        original: { ...change.original },
        modified: { ...change.modified },
      })),
    }));
  }
  get options(): TextEditorOptions {
    return this.liveOptions.options;
  }
  set options(value: TextEditorOptions) {
    this.liveOptions.assign(value);
  }
  private applyOptions(value: TextEditorOptions): void {
    void this.bridge.callMain("editor.setOptions", this.document.uri.toJSON(), value);
  }
  async insertSnippet(
    snippet: SnippetString,
    location?: Position | Range | readonly Position[] | readonly Range[],
    options?: { undoStopBefore?: boolean; undoStopAfter?: boolean },
  ): Promise<boolean> {
    if (typeof snippet?.value !== "string") throw new TypeError("Invalid snippet");
    const locations: readonly (Position | Range)[] | undefined =
      location === undefined
        ? undefined
        : Array.isArray(location)
          ? location
          : [location as Position | Range];
    const ranges = locations?.map((value) =>
      Range.isRange(value) ? Range.of(value) : new Range(Position.of(value), Position.of(value)),
    );
    const result = (await this.bridge.callMain(
      "editor.insertSnippet",
      this.document.uri.toJSON(),
      this.document.version,
      snippet.value,
      ranges,
      options,
    )) as boolean | { applied: boolean; document: TextDocumentSnapshot; selections: Selection[] };
    if (typeof result === "boolean") return result;
    reviveTextDocument(this.bridge, result.document);
    this.snapshot.selections = result.selections.map(
      (value) => new Selection(value.anchor, value.active),
    );
    return result.applied;
  }
  async edit(
    callback: (builder: EditorEditBuilder) => void,
    options?: { undoStopBefore?: boolean; undoStopAfter?: boolean },
  ): Promise<boolean> {
    const version = this.document.version;
    const edits: { range: Range; text: string }[] = [];
    let endOfLine: 1 | 2 | undefined;
    let active = true;
    const add = (range: Range, text: string) => {
      if (!active) throw new Error("Edit builder can only be used during the callback");
      edits.push({ range, text });
    };
    try {
      callback({
        replace: (location, text) =>
          add(Range.isRange(location) ? Range.of(location) : new Range(location, location), text),
        insert: (location, text) => add(new Range(location, location), text),
        delete: (range) => add(Range.of(range), ""),
        setEndOfLine: (value) => {
          if (!active) throw new Error("Edit builder can only be used during the callback");
          if (value !== 1 && value !== 2) throw new Error("Invalid end of line sequence");
          endOfLine = value;
        },
      });
    } finally {
      active = false;
    }
    const result = (await this.bridge.callMain(
      "editor.edit",
      this.document.uri.toJSON(),
      version,
      edits,
      endOfLine,
      options,
    )) as boolean | { applied: boolean; document: TextDocumentSnapshot };
    if (typeof result === "boolean") return result;
    reviveTextDocument(this.bridge, result.document);
    return result.applied;
  }
  revealRange(range: Range, revealType = 0): void {
    void this.bridge.callMain(
      "editor.revealRange",
      this.document.uri.toJSON(),
      Range.of(range),
      revealType,
    );
  }
  setDecorations(type: { key: string }, ranges: readonly unknown[]): void {
    void this.bridge.callMain(
      "editor.setDecorations",
      type.key,
      ranges,
      this.document.uri.toJSON(),
    );
  }
}
