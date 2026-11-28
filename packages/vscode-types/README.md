```ts
type Event<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

class Disposable {
  constructor(callOnDispose: () => unknown);
  static from(...disposables: { dispose(): unknown }[]): Disposable;
  dispose(): void; // Calls its callback once.
}

class EventEmitter<T> {
  readonly event: Event<T>;
  fire(event: T): void;
  dispose(): void;
}

enum IndentAction { None = 0, Indent = 1, IndentOutdent = 2, Outdent = 3 }
enum SyntaxTokenType { Other = 0, Comment = 1, String = 2, RegEx = 3 }

interface LanguageConfiguration {
  comments?: { lineComment?: string | { comment: string; noIndent?: boolean }; blockComment?: [string, string] };
  brackets?: [string, string][];
  wordPattern?: RegExp;
  indentationRules?: { decreaseIndentPattern: RegExp; increaseIndentPattern: RegExp; indentNextLinePattern?: RegExp; unIndentedLinePattern?: RegExp };
  onEnterRules?: { beforeText: RegExp; afterText?: RegExp; previousLineText?: RegExp; action: { indentAction: IndentAction; appendText?: string; removeText?: number } }[];
  autoClosingPairs?: { open: string; close: string; notIn?: SyntaxTokenType[] }[];
  __characterPairSupport?: { autoClosingPairs: { open: string; close: string; notIn?: string[] }[] }; // Deprecated.
  __electricCharacterSupport?: { brackets?: unknown; docComment?: { scope: string; open: string; lineStart: string; close?: string } }; // Deprecated.
}

class CancellationTokenSource {
  readonly token: CancellationToken;
  cancel(): void;
  dispose(): void;
}

class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;
  static file(path: string): Uri;
  static parse(value: string, strict?: boolean): Uri;
  static from(components: UriComponents): Uri;
  static joinPath(base: Uri, ...segments: string[]): Uri;
  with(change: Partial<UriComponents>): Uri;
  toString(skipEncoding?: boolean): string;
  toJSON(): UriComponents;
}

class Position {
  constructor(line: number, character: number);
  readonly line: number;
  readonly character: number;
  compareTo(other: Position): number;
  isBefore(other: Position): boolean;
  isBeforeOrEqual(other: Position): boolean;
  isAfter(other: Position): boolean;
  isAfterOrEqual(other: Position): boolean;
  isEqual(other: Position): boolean;
  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
}

class Range {
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  readonly start: Position;
  readonly end: Position;
  readonly isEmpty: boolean;
  readonly isSingleLine: boolean;
  contains(positionOrRange: Position | Range): boolean;
  isEqual(other: Range): boolean;
  intersection(other: Range): Range | undefined;
  union(other: Range): Range;
  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
}

interface LocationLink {
  originSelectionRange?: Range;
  targetUri: Uri;
  targetRange: Range;
  targetSelectionRange?: Range;
}

class Selection extends Range {
  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  readonly anchor: Position;
  readonly active: Position;
  readonly isReversed: boolean;
}

interface ColorTheme {
  readonly kind: ColorThemeKind;
}

class WorkspaceEdit {
  readonly size: number; // Number of resources with text edits.
  replace(uri: Uri, range: Range, newText: string, metadata?: WorkspaceEditEntryMetadata): void;
  insert(
    uri: Uri,
    position: Position,
    newText: string,
    metadata?: WorkspaceEditEntryMetadata,
  ): void;
  delete(uri: Uri, range: Range, metadata?: WorkspaceEditEntryMetadata): void;
  set(uri: Uri, edits: readonly (TextEdit | SnippetTextEdit | NotebookEdit | [TextEdit | SnippetTextEdit | NotebookEdit, WorkspaceEditEntryMetadata | undefined])[] | null | undefined): void;
  get(uri: Uri): TextEdit[];
  has(uri: Uri): boolean;
  entries(): [Uri, TextEdit[]][];
  createFile(uri: Uri, options?: FileOperationOptions, metadata?: WorkspaceEditEntryMetadata): void;
  deleteFile(uri: Uri, options?: FileOperationOptions, metadata?: WorkspaceEditEntryMetadata): void;
  renameFile(
    uri: Uri,
    target: Uri,
    options?: FileOperationOptions,
    metadata?: WorkspaceEditEntryMetadata,
  ): void;
  _allEntries(): readonly WorkspaceEditEntry[]; // Ordered entries for compatibility bridges.
}

class MarkdownString {
  constructor(value?: string, supportThemeIcons?: boolean);
  value: string;
  appendText(value: string): this;
  appendMarkdown(value: string): this;
  appendCodeblock(value: string, language?: string): this;
}

class SnippetString {
  constructor(value?: string);
  value: string;
  appendText(value: string): this;
  appendTabstop(number?: number): this;
  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number?: number): this;
  appendChoice(values: readonly string[], number?: number): this;
  appendVariable(name: string, defaultValue?: string | ((snippet: SnippetString) => unknown)): this;
}

class TimelineItem {
  constructor(label: string, timestamp: number);
  constructor(resourceUri: Uri, timestamp: number);
  label?: string;
  resourceUri?: Uri;
  timestamp: number;
}

class LanguageModelTextPart { constructor(value: string, audience?: number[]); value: string; audience?: number[]; }
class LanguageModelChatMessage {
  constructor(role: LanguageModelChatMessageRole, content: string | unknown[], name?: string);
  role: LanguageModelChatMessageRole;
  content: unknown[];
  name?: string;
  static User(content: string | unknown[], name?: string): LanguageModelChatMessage;
  static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage;
}
class LanguageModelToolCallPart { constructor(callId: string, name: string, input: unknown); callId: string; name: string; input: unknown; }
class LanguageModelToolResultPart { constructor(callId: string, content: unknown[], isError?: boolean); callId: string; content: unknown[]; isError: boolean; }
class LanguageModelDataPart {
  constructor(data: Uint8Array, mimeType: string, audience?: number[]);
  data: Uint8Array;
  mimeType: string;
  audience?: number[];
  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart;
  static json(value: object, mime?: string): LanguageModelDataPart;
  static text(value: string, mime?: string): LanguageModelDataPart;
}
class LanguageModelThinkingPart { constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>); value: string | string[]; id?: string; metadata?: Record<string, unknown>; }
class LanguageModelError extends Error {
  readonly code: string;
  readonly retryAfter?: number;
  static NotFound(message?: string): LanguageModelError;
  static NoPermissions(message?: string): LanguageModelError;
  static Blocked(message?: string): LanguageModelError;
  static RateLimited(message?: string, retryAfter?: number): LanguageModelError;
}
class ChatResponseMarkdownPart { constructor(value: string | MarkdownString); value: MarkdownString; }
class ChatResponseThinkingProgressPart { constructor(value: string | string[], id?: string, metadata?: Record<string, unknown>); value: string | string[]; id?: string; metadata?: Record<string, unknown>; }
class LanguageModelToolResult { constructor(content: unknown[]); content: unknown[]; }

class SemanticTokensLegend {
  constructor(tokenTypes: string[], tokenModifiers?: string[]);
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];
}

class SemanticTokens {
  constructor(data: Uint32Array, resultId?: string);
  readonly data: Uint32Array;
  readonly resultId: string | undefined;
}

class SemanticTokensBuilder {
  constructor(legend?: SemanticTokensLegend);
  push(line: number, character: number, length: number, tokenType: number, tokenModifiers?: number): void;
  push(range: Range, tokenType: string, tokenModifiers?: string[]): void;
  build(resultId?: string): SemanticTokens; // Sorts by position and emits delta-encoded tokens.
}

class CallHierarchyItem {
  constructor(kind: SymbolKind, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range);
  kind: SymbolKind;
  name: string;
  detail?: string;
  uri: Uri;
  range: Range;
  selectionRange: Range;
}

class TypeHierarchyItem {
  constructor(kind: SymbolKind, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range);
  tags?: SymbolTag[];
}

class LinkedEditingRanges {
  constructor(ranges: Range[], wordPattern?: RegExp);
  readonly ranges: Range[];
  readonly wordPattern?: RegExp;
}

class MultiDocumentHighlight {
  constructor(uri: Uri, highlights: DocumentHighlight[]);
  uri: Uri;
  highlights: DocumentHighlight[];
}

class TabInputText { constructor(uri: Uri); readonly uri: Uri; }
class TabInputTextDiff { constructor(original: Uri, modified: Uri); readonly original: Uri; readonly modified: Uri; }
class TabInputNotebook { constructor(uri: Uri, notebookType: string); readonly uri: Uri; readonly notebookType: string; }
class TabInputNotebookDiff { constructor(original: Uri, modified: Uri, notebookType: string); readonly original: Uri; readonly modified: Uri; readonly notebookType: string; }
class TabInputCustom { constructor(uri: Uri, viewType: string); readonly uri: Uri; readonly viewType: string; }
class TabInputWebview { constructor(viewType: string); readonly viewType: string; }
class TabInputTerminal {}

class TabGroupsData {
  constructor(close: (kind: "tabs" | "groups", ids: string[], preserveFocus: boolean) => Promise<boolean>);
  readonly all: readonly TabGroup[];
  readonly activeTabGroup: TabGroup;
  readonly onDidChangeTabs: Event<TabChangeEvent>;
  readonly onDidChangeTabGroups: Event<TabGroupChangeEvent>;
  update(snapshot: TabGroupsSnapshot): void; // Preserves tab and group identity across snapshots.
  close(items: Tab | TabGroup | readonly Tab[] | readonly TabGroup[], preserveFocus?: boolean): Promise<boolean>;
  dispose(): void;
}

class DataTransferItem {
  constructor(value: unknown);
  readonly value: unknown;
  asString(): Promise<string>;
  asFile(): undefined;
}
class DataTransfer implements Iterable<[string, DataTransferItem]> {
  constructor(entries?: Iterable<readonly [string, DataTransferItem]>);
  get(mimeType: string): DataTransferItem | undefined;
  set(mimeType: string, value: DataTransferItem): void;
  forEach(callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => unknown, thisArg?: unknown): void;
}
class DocumentDropOrPasteEditKind {
  static readonly Empty: DocumentDropOrPasteEditKind;
  static readonly Text: DocumentDropOrPasteEditKind;
  static readonly TextUpdateImports: DocumentDropOrPasteEditKind;
  constructor(value: string);
  readonly value: string;
  append(...parts: string[]): DocumentDropOrPasteEditKind;
  contains(other: DocumentDropOrPasteEditKind): boolean;
  intersects(other: DocumentDropOrPasteEditKind): boolean;
}
class DocumentDropEdit {
  constructor(insertText: string | SnippetString, title?: string, kind?: DocumentDropOrPasteEditKind);
  additionalEdit?: WorkspaceEdit;
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
}
class DocumentPasteEdit {
  constructor(insertText: string | SnippetString, title: string, kind: DocumentDropOrPasteEditKind);
  insertText: string | SnippetString;
  title: string;
  kind: DocumentDropOrPasteEditKind;
  additionalEdit?: WorkspaceEdit;
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
}

const NotebookCellKind: { readonly Markup: 1; readonly Code: 2 };
class NotebookRange {
  constructor(start: number, end: number);
  readonly start: number;
  readonly end: number;
  readonly isEmpty: boolean;
  with(change: { start?: number; end?: number }): NotebookRange;
}
class NotebookCellOutputItem {
  constructor(data: Uint8Array, mime: string);
  data: Uint8Array;
  mime: string;
  static text(value: string, mime?: string): NotebookCellOutputItem;
  static json(value: unknown, mime?: string): NotebookCellOutputItem;
  static stdout(value: string): NotebookCellOutputItem;
  static stderr(value: string): NotebookCellOutputItem;
  static error(value: Error): NotebookCellOutputItem;
}
class NotebookCellOutput {
  constructor(items: NotebookCellOutputItem[], metadata?: Record<string, unknown>);
  items: NotebookCellOutputItem[];
  metadata?: Record<string, unknown>;
}
class NotebookCellData {
  constructor(kind: NotebookCellKind, value: string, languageId: string);
  kind: NotebookCellKind;
  value: string;
  languageId: string;
  metadata?: Record<string, unknown>;
  outputs?: NotebookCellOutput[];
  executionSummary?: NotebookCellExecutionSummary;
}
class NotebookData {
  constructor(cells: NotebookCellData[]);
  cells: NotebookCellData[];
  metadata?: Record<string, unknown>;
}
class NotebookEdit {
  constructor(range: NotebookRange, newCells: NotebookCellData[]);
  range: NotebookRange;
  newCells: NotebookCellData[];
  newCellMetadata?: Record<string, unknown>;
  newNotebookMetadata?: Record<string, unknown>;
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit;
  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit;
  static deleteCells(range: NotebookRange): NotebookEdit;
  static updateCellMetadata(index: number, metadata: Record<string, unknown>): NotebookEdit;
  static updateNotebookMetadata(metadata: Record<string, unknown>): NotebookEdit;
}

interface TextDocumentSnapshot {
  readonly uri: UriComponents;
  readonly text: string;
  readonly version: number;
  readonly languageId: string;
  readonly isDirty: boolean;
  readonly eol: 1 | 2;
  readonly encoding?: string;
  readonly isClosed?: boolean;
  readonly isUntitled?: boolean;
}

class TextDocumentData {
  constructor(snapshot: TextDocumentSnapshot, saveDocument?: () => Promise<boolean>);
  readonly uri: Uri;
  readonly fileName: string;
  readonly isUntitled: boolean;
  readonly languageId: string;
  readonly encoding: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isClosed: boolean;
  readonly eol: 1 | 2;
  readonly lineCount: number;
  getText(range?: Range): string;
  lineAt(lineOrPosition: number | Position): TextLine;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  validatePosition(position: Position): Position;
  validateRange(range: Range): Range;
  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined;
  save(): Promise<boolean>;
  update(snapshot: TextDocumentSnapshot): void; // Refreshes the existing document object.
  toJSON(): TextDocumentSnapshot;
}

interface TextEditorOptions {
  tabSize?: number | string;
  indentSize?: number | string;
  insertSpaces?: boolean | string;
  cursorStyle?: TextEditorCursorStyle;
  lineNumbers?: TextEditorLineNumbersStyle;
}

interface ResolvedTextEditorOptions {
  tabSize: number;
  indentSize: number;
  insertSpaces: boolean;
  cursorStyle: TextEditorCursorStyle;
  lineNumbers: TextEditorLineNumbersStyle;
}
```
