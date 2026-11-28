import { DiagnosticSeverity, DocumentHighlightKind, TreeItemCollapsibleState } from "./enums.ts";
import { MarkdownString, SnippetString, TextEdit, type Command } from "./editing.ts";
import { Position, Range } from "./geometry.ts";
import { Uri } from "./uri.ts";

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TimelineItem {
  label?: string;
  resourceUri?: Uri;
  timestamp: number;
  id?: string;
  iconPath?: Uri | { light: Uri; dark: Uri } | ThemeIcon;
  description?: string;
  command?: Command;
  contextValue?: string;
  tooltip?: string | MarkdownString;
  accessibilityInformation?: { label: string; role?: string };

  constructor(label: string, timestamp: number);
  constructor(resourceUri: Uri, timestamp: number);
  constructor(labelOrUri: string | Uri, timestamp: number) {
    if (Uri.isUri(labelOrUri)) this.resourceUri = labelOrUri;
    else this.label = labelOrUri;
    this.timestamp = timestamp;
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  readonly id: string;
  readonly color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

export class Location {
  uri: Uri;
  range!: Range;
  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    if (rangeOrPosition == null) return;
    this.range = Range.isRange(rangeOrPosition)
      ? Range.of(rangeOrPosition)
      : new Range(rangeOrPosition, rangeOrPosition);
  }
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: Uri;
  targetRange: Range;
  targetSelectionRange?: Range;
}

export type MarkedString = string | { language: string; value: string };

export class Hover {
  contents: (MarkdownString | MarkedString)[];
  range?: Range;
  constructor(
    contents: MarkdownString | MarkedString | (MarkdownString | MarkedString)[],
    range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

export interface CompletionItemLabel {
  label: string;
  detail?: string;
  description?: string;
}

export class CompletionItem {
  label: string | CompletionItemLabel;
  kind?: number;
  tags?: readonly number[];
  detail?: string;
  documentation?: string | MarkdownString;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  command?: Command;
  constructor(label: string | CompletionItemLabel, kind?: number) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList<T extends CompletionItem = CompletionItem> {
  items: T[];
  isIncomplete: boolean;
  constructor(items: T[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export class DiagnosticRelatedInformation {
  location: Location;
  message: string;
  constructor(location: Location, message: string) {
    this.location = location;
    this.message = message;
  }
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: number;
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  tags?: readonly number[];
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(range: Range, message: string, severity: number = DiagnosticSeverity.Error) {
    if (!Range.isRange(range)) throw new TypeError("range must be set");
    if (!message) throw new TypeError("message must be set");
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

export class CodeLens {
  range: Range;
  command?: Command;
  constructor(range: Range, command?: Command) {
    this.range = range;
    this.command = command;
  }
  get isResolved(): boolean {
    return !!this.command;
  }
}

export class CallHierarchyItem {
  kind: number;
  tags?: number[];
  name: string;
  detail?: string;
  uri: Uri;
  range: Range;
  selectionRange: Range;

  constructor(
    kind: number,
    name: string,
    detail: string,
    uri: Uri,
    range: Range,
    selectionRange: Range,
  ) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class TypeHierarchyItem {
  kind: number;
  tags?: number[];
  name: string;
  detail?: string;
  uri: Uri;
  range: Range;
  selectionRange: Range;

  constructor(
    kind: number,
    name: string,
    detail: string,
    uri: Uri,
    range: Range,
    selectionRange: Range,
  ) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];

  constructor(item: CallHierarchyItem, fromRanges: Range[]) {
    this.from = item;
    this.fromRanges = fromRanges;
  }
}

export class CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];

  constructor(item: CallHierarchyItem, fromRanges: Range[]) {
    this.to = item;
    this.fromRanges = fromRanges;
  }
}

export class LinkedEditingRanges {
  readonly ranges: Range[];
  readonly wordPattern?: RegExp;

  constructor(ranges: Range[], wordPattern?: RegExp) {
    this.ranges = ranges;
    this.wordPattern = wordPattern;
  }
}

export class DocumentHighlight {
  range: Range;
  kind: number;
  constructor(range: Range, kind: number = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

export class MultiDocumentHighlight {
  uri: Uri;
  highlights: DocumentHighlight[];
  constructor(uri: Uri, highlights: DocumentHighlight[]) {
    this.uri = uri;
    this.highlights = highlights;
  }
}

export class DocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  tags?: readonly number[];
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[] = [];
  constructor(name: string, detail: string, kind: number, range: Range, selectionRange: Range) {
    if (!name) throw new Error("name must not be empty");
    if (!range.contains(selectionRange))
      throw new Error("selectionRange must be contained in range");
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class SymbolInformation {
  name: string;
  kind: number;
  tags?: readonly number[];
  containerName: string;
  location: Location;
  constructor(name: string, kind: number, containerName: string, location: Location);
  constructor(name: string, kind: number, range: Range, uri?: Uri, containerName?: string);
  constructor(
    name: string,
    kind: number,
    containerOrRange: string | Range,
    locationOrUri?: Location | Uri,
    containerName = "",
  ) {
    this.name = name;
    this.kind = kind;
    if (typeof containerOrRange === "string") {
      this.containerName = containerOrRange;
      this.location = locationOrUri as Location;
    } else {
      this.containerName = containerName;
      this.location = new Location(locationOrUri as Uri, containerOrRange);
    }
  }
}

export class DocumentLink {
  range: Range;
  target?: Uri;
  tooltip?: string;
  constructor(range: Range, target?: Uri) {
    this.range = range;
    this.target = target;
  }
}

export class Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
  constructor(red: number, green: number, blue: number, alpha: number) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
}

export class ColorInformation {
  range: Range;
  color: Color;
  constructor(range: Range, color: Color) {
    this.range = range;
    this.color = color;
  }
}

export class ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  constructor(label: string) {
    this.label = label;
  }
}

export class InlayHintLabelPart {
  value: string;
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: Command;
  constructor(value: string) {
    this.value = value;
  }
}

export class InlayHint {
  position: Position;
  label: string | InlayHintLabelPart[];
  kind?: number;
  textEdits?: TextEdit[];
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  constructor(position: Position, label: string | InlayHintLabelPart[], kind?: number) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

export class FoldingRange {
  start: number;
  end: number;
  kind?: number;
  constructor(start: number, end: number, kind?: number) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export class SelectionRange {
  range: Range;
  parent?: SelectionRange;
  constructor(range: Range, parent?: SelectionRange) {
    if (parent && !parent.range.contains(range)) throw new Error("parent range must contain range");
    this.range = range;
    this.parent = parent;
  }
}

export class ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkdownString;
  constructor(label: string | [number, number], documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureInformation {
  label: string;
  documentation?: string | MarkdownString;
  parameters: ParameterInformation[] = [];
  activeParameter?: number;
  constructor(label: string, documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export class InlineCompletionItem {
  insertText: string | SnippetString;
  filterText?: string;
  range?: Range;
  command?: Command;
  constructor(insertText: string | SnippetString, range?: Range, command?: Command) {
    this.insertText = insertText;
    this.range = range;
    this.command = command;
  }
}

export class InlineCompletionList {
  items: InlineCompletionItem[];
  constructor(items: InlineCompletionItem[]) {
    this.items = items;
  }
}

export class TreeItem {
  label?: string | { label: string; highlights?: [number, number][] };
  id?: string;
  resourceUri?: Uri;
  collapsibleState: number;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  command?: Command;
  iconPath?: ThemeIcon | Uri | string | { light: Uri | string; dark: Uri | string };
  contextValue?: string;
  accessibilityInformation?: { label: string; role?: string };
  checkboxState?:
    | number
    | {
        state: number;
        tooltip?: string;
        accessibilityInformation?: { label: string; role?: string };
      };
  constructor(
    labelOrUri: string | { label: string; highlights?: [number, number][] } | Uri,
    collapsibleState: number = TreeItemCollapsibleState.None,
  ) {
    if (Uri.isUri(labelOrUri)) this.resourceUri = labelOrUri;
    else this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}

export class FileDecoration {
  badge?: string;
  tooltip?: string;
  color?: ThemeColor;
  propagate?: boolean;
  constructor(badge?: string, tooltip?: string, color?: ThemeColor) {
    this.badge = badge;
    this.tooltip = tooltip;
    this.color = color;
  }
}

export class TerminalLink {
  startIndex: number;
  length: number;
  tooltip?: string;
  constructor(startIndex: number, length: number, tooltip?: string) {
    this.startIndex = startIndex;
    this.length = length;
    this.tooltip = tooltip;
  }
}

export class McpStdioServerDefinition {
  readonly label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  cwd?: Uri;
  version?: string;
  constructor(
    label: string,
    command: string,
    args: string[] = [],
    env: Record<string, string | number | null> = {},
    version?: string,
  ) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.env = env;
    this.version = version;
  }
}

export class McpHttpServerDefinition {
  readonly label: string;
  uri: Uri;
  headers: Record<string, string>;
  version?: string;
  constructor(label: string, uri: Uri, headers: Record<string, string> = {}, version?: string) {
    this.label = label;
    this.uri = uri;
    this.headers = headers;
    this.version = version;
  }
}

export class FileSystemError extends Error {
  readonly code: string;

  constructor(messageOrUri?: string | Uri, code = "Unknown") {
    super(Uri.isUri(messageOrUri) ? messageOrUri.toString(true) : messageOrUri);
    this.code = code;
    const providerCodes: Record<string, string> = {
      FileNotFound: "EntryNotFound",
      FileExists: "EntryExists",
      FileNotADirectory: "EntryNotADirectory",
      FileIsADirectory: "EntryIsADirectory",
    };
    this.name = `${providerCodes[code] ?? code} (FileSystemError)`;
  }

  static FileNotFound(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "FileNotFound");
  }
  static FileExists(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "FileExists");
  }
  static FileNotADirectory(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "FileNotADirectory");
  }
  static FileIsADirectory(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "FileIsADirectory");
  }
  static NoPermissions(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "NoPermissions");
  }
  static Unavailable(value?: string | Uri): FileSystemError {
    return new FileSystemError(value, "Unavailable");
  }
}
