import { inject } from "@harness/di";
import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { ICommandService } from "monaco-editor/esm/vs/platform/commands/common/commands.js";
import { onScopeDispose } from "vue";
import { ILanguageFeaturesService } from "monaco-editor/esm/vs/editor/common/services/languageFeatures.js";
import { getLinks } from "monaco-editor/esm/vs/editor/contrib/links/browser/getLinks.js";
import {
  CodeActionKind,
  type Color,
  type ColorInformation,
  type ColorPresentation,
  type DocumentSymbol as VscodeDocumentSymbol,
  type LocationLink,
  type TextDocumentSnapshot,
  CompletionItem,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  Hover,
  Location,
  MarkdownString,
  Position,
  Range,
  TextDocumentData,
  TextEdit,
  Uri,
  type UriComponents,
  type Disposable,
  type LanguageConfigurationSnapshot,
} from "@harness/vscode-types";
import { VscodeWorkspaceCompatService } from "./index.ts";
import { registerRuntimeLanguageConfiguration } from "./language-configuration.ts";

export { CompletionItem, Diagnostic, DiagnosticSeverity, Hover, Location };

type Result<T> = T | undefined | null | PromiseLike<T | undefined | null>;
type Token = monaco.CancellationToken;
type Event<T> = (listener: (event: T) => unknown) => { dispose(): void };
import { documentUriForModel } from "./model-uri.ts";

type PositionData = { line: number; character: number };
type RangeData = { start: PositionData; end: PositionData };
type UriData =
  | string
  | { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string };
type MarkdownData = {
  value: string;
  isTrusted?: boolean | { enabledCommands: readonly string[] };
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  baseUri?: UriData;
};
type Documentation = string | MarkdownData;
type HoverQueryResult = {
  contents: readonly Omit<monaco.IMarkdownString, "uris">[];
  range?: RangeData;
};
type Command = { command: string; title: string; tooltip?: string; arguments?: unknown[] };
type TextEditData = { range: RangeData; newText: string; newEol?: 1 | 2 };
type WorkspaceEditData = {
  entries: readonly [UriData, readonly TextEditData[]][] | (() => [Uri, TextEditData[]][]);
  _allEntries?(): readonly { type: string }[];
};
type LocationData = { uri: UriData; range: RangeData };
type LocationLinkData = {
  targetUri: UriData;
  targetRange: RangeData;
  targetSelectionRange?: RangeData;
  originSelectionRange?: RangeData;
};
type SelectionRangeData = { range: RangeData; parent?: SelectionRangeData };
type DefinitionResult = LocationData | readonly LocationData[] | readonly LocationLinkData[];

export type SemanticTokensQuery =
  | { command: "provideDocumentSemanticTokens" | "provideDocumentSemanticTokensLegend" }
  | { command: "provideDocumentRangeSemanticTokens"; range: RangeData }
  | { command: "provideDocumentRangeSemanticTokensLegend"; range?: RangeData };

type FormatOptions = { tabSize: number; insertSpaces: boolean };
export type FormattingQuery =
  | { kind: "document"; options?: unknown }
  | { kind: "range"; range: RangeData; options?: unknown }
  | { kind: "onType"; position: PositionData; character: string; options?: unknown };

type DocumentFilter = {
  language?: string;
  scheme?: string;
  pattern?: string | { baseUri?: UriData; base?: string; pattern: string };
  notebookType?: string;
};
export type DocumentSelector = string | DocumentFilter | readonly (string | DocumentFilter)[];

type CompletionData = {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  tags?: readonly number[];
  detail?: string;
  documentation?: Documentation;
  insertText?: string | { value: string };
  range?: RangeData | { inserting: RangeData; replacing: RangeData };
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  commitCharacters?: string[];
  additionalTextEdits?: TextEditData[];
  command?: Command;
  keepWhitespace?: boolean;
  textEdit?: TextEditData;
};
type CompletionResult =
  | readonly CompletionData[]
  | { items: readonly CompletionData[]; isIncomplete?: boolean; dispose?(): void };
type CodeActionData = {
  title: string;
  kind?: { value: string };
  edit?: WorkspaceEditData;
  applyWorkspaceEdit?(): Promise<unknown>;
  command?: Command;
  diagnostics?: readonly Diagnostic[];
  disabled?: { reason: string };
  isPreferred?: boolean;
};
type InlineCompletionData = {
  insertText: string | { value: string };
  range?: RangeData;
  filterText?: string;
  command?: Command;
};
type SymbolData = {
  name: string;
  detail?: string;
  kind: number;
  tags?: readonly number[];
  range: RangeData;
  selectionRange: RangeData;
  children?: SymbolData[];
};
type SymbolInformationData = {
  name: string;
  kind: number;
  tags?: readonly number[];
  containerName?: string;
  location: LocationData;
};
type DocumentSymbolQueryResult = Omit<VscodeDocumentSymbol, "children"> & {
  containerName?: string;
  children: DocumentSymbolQueryResult[];
};
type SignatureHelpData = {
  signatures: {
    label: string;
    documentation?: Documentation;
    parameters?: { label: string | [number, number]; documentation?: Documentation }[];
    activeParameter?: number;
  }[];
  activeSignature: number;
  activeParameter: number;
};
type DocumentLinkData = { range: RangeData; target?: UriData; tooltip?: string };
type DocumentLinkQueryResult = { range: Range; target?: UriComponents; tooltip?: string };
type ColorData = { red: number; green: number; blue: number; alpha: number };
type ColorPresentationData = {
  label: string;
  textEdit?: TextEditData;
  additionalTextEdits?: TextEditData[];
};
type InlayHintData = {
  position: PositionData;
  label:
    | string
    | { value: string; tooltip?: Documentation; location?: LocationData; command?: Command }[];
  kind?: number;
  textEdits?: TextEditData[];
  tooltip?: Documentation;
  paddingLeft?: boolean;
  paddingRight?: boolean;
};
type CodeLensData = { range: RangeData; command?: Command };

function toUri(value: UriData): monaco.Uri {
  return typeof value === "string"
    ? monaco.Uri.parse(value)
    : monaco.Uri.from({ ...value, scheme: value.scheme ?? "file" });
}
function toRange(range: RangeData): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
function fromRange(range: monaco.IRange): Range {
  return new Range(
    new Position(range.startLineNumber - 1, range.startColumn - 1),
    new Position(range.endLineNumber - 1, range.endColumn - 1),
  );
}

function decodeFullSemanticTokens(bytes: Uint8Array | undefined): number[] | undefined {
  if (!bytes || bytes.byteLength < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Monaco prefixes little-endian token words with the result ID, encoding type, and word count.
  const full = view.getUint32(4, true) === 1;
  const count = view.getUint32(8, true);
  if (!full || bytes.byteLength !== 12 + count * 4) return undefined;
  return Array.from({ length: count }, (_, index) => view.getUint32(12 + index * 4, true));
}

function nestDocumentSymbols(
  symbols: monaco.languages.DocumentSymbol[],
): monaco.languages.DocumentSymbol[] {
  symbols.sort((a, b) => {
    const first = a.range;
    const second = b.range;
    return (
      first.startLineNumber - second.startLineNumber ||
      first.startColumn - second.startColumn ||
      second.endLineNumber - first.endLineNumber ||
      second.endColumn - first.endColumn
    );
  });
  const roots: monaco.languages.DocumentSymbol[] = [];
  const parents: monaco.languages.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    while (parents.length) {
      const parent = parents.at(-1)!;
      if (
        monaco.Range.containsRange(parent.range, symbol.range) &&
        !monaco.Range.equalsRange(parent.range, symbol.range)
      )
        break;
      parents.pop();
    }
    const parent = parents.at(-1);
    if (parent) (parent.children ??= []).push(symbol);
    else roots.push(symbol);
    parents.push(symbol);
  }
  return roots;
}

function fromPosition(position: monaco.IPosition): Position {
  return new Position(position.lineNumber - 1, position.column - 1);
}
function toLocations(
  result: DefinitionResult | null | undefined,
): monaco.languages.LocationLink[] | undefined {
  if (!result) return undefined;
  const locations = (Array.isArray(result) ? result : [result]) as readonly (
    | LocationData
    | LocationLinkData
  )[];
  return locations.map((location) =>
    "targetUri" in location
      ? {
          uri: toUri(location.targetUri),
          range: toRange(location.targetRange),
          targetSelectionRange: location.targetSelectionRange
            ? toRange(location.targetSelectionRange)
            : undefined,
          originSelectionRange: location.originSelectionRange
            ? toRange(location.originSelectionRange)
            : undefined,
        }
      : { uri: toUri(location.uri), range: toRange(location.range) },
  );
}
function toMarkdown(value: Documentation): string | monaco.IMarkdownString {
  if (typeof value === "string") return value;
  return { ...value, baseUri: value.baseUri ? toUri(value.baseUri) : undefined };
}
function fromMarkdown(value: string | monaco.IMarkdownString): Documentation {
  if (typeof value === "string") return value;
  return Object.assign(new MarkdownString(value.value, value.supportThemeIcons), {
    isTrusted: value.isTrusted,
    supportHtml: value.supportHtml,
    baseUri: value.baseUri ? Uri.from(value.baseUri) : undefined,
  });
}
function fromSignatureHelp(help: monaco.languages.SignatureHelp): SignatureHelpData {
  return {
    ...help,
    signatures: help.signatures.map((signature) => ({
      ...signature,
      documentation:
        signature.documentation === undefined ? undefined : fromMarkdown(signature.documentation),
      parameters: signature.parameters.map((parameter) => ({
        ...parameter,
        documentation:
          parameter.documentation === undefined ? undefined : fromMarkdown(parameter.documentation),
      })),
    })),
  };
}
function toCommand(value?: Command): monaco.languages.Command | undefined {
  return value
    ? { id: value.command, title: value.title, tooltip: value.tooltip, arguments: value.arguments }
    : undefined;
}
function toEdit(edit: TextEditData): monaco.languages.TextEdit {
  return {
    range: toRange(edit.range),
    text: edit.newText,
    eol: edit.newEol === undefined ? undefined : edit.newEol - 1,
  };
}
function fromEdit(edit: monaco.languages.TextEdit): TextEdit {
  const eol =
    edit.eol === undefined ? undefined : edit.eol === monaco.editor.EndOfLineSequence.LF ? 1 : 2;
  // The editor worker uses a zero range for an EOL-only edit.
  if (eol !== undefined && edit.range.startLineNumber === 0) return TextEdit.setEndOfLine(eol);
  return Object.assign(new TextEdit(fromRange(edit.range), edit.text), { newEol: eol });
}
function toWorkspaceEdit(edit?: WorkspaceEditData): monaco.languages.WorkspaceEdit | undefined {
  if (!edit) return undefined;
  if (edit._allEntries?.().some((entry) => entry.type !== "text")) {
    throw new Error(
      "Language provider WorkspaceEdit file and snippet operations are not supported",
    );
  }
  const entries = typeof edit.entries === "function" ? edit.entries() : edit.entries;
  return {
    edits: entries.flatMap(([uri, edits]) =>
      edits.map((entry) => ({
        resource: toUri(uri),
        textEdit: toEdit(entry),
        versionId: undefined,
      })),
    ),
  };
}
function toSelector(selector: DocumentSelector): monaco.languages.LanguageSelector {
  if (typeof selector === "string") return selector;
  const filters = (Array.isArray(selector) ? selector : [selector]) as readonly (
    | string
    | DocumentFilter
  )[];
  return filters.flatMap((filter) => {
    if (typeof filter === "string") return [{ language: filter }];
    if (filter.notebookType) return [];
    const pattern =
      typeof filter.pattern === "string"
        ? filter.pattern
        : filter.pattern
          ? {
              base: filter.pattern.baseUri
                ? toUri(filter.pattern.baseUri).fsPath
                : (filter.pattern.base ?? ""),
              pattern: filter.pattern.pattern,
            }
          : undefined;
    return [{ language: filter.language, scheme: filter.scheme, pattern }];
  });
}

const completionKinds = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
  "User",
  "Issue",
] as const;
function toCompletion(
  item: CompletionData,
  fallbackRange: monaco.languages.CompletionItem["range"],
): monaco.languages.CompletionItem {
  const range = item.textEdit?.range ?? item.range;
  const snippet = typeof item.insertText === "object";
  return {
    label: item.label,
    kind: monaco.languages.CompletionItemKind[completionKinds[item.kind ?? 9] ?? "Property"],
    tags: item.tags ? [...item.tags] : undefined,
    detail: item.detail,
    documentation: item.documentation === undefined ? undefined : toMarkdown(item.documentation),
    insertText:
      item.textEdit?.newText ??
      (typeof item.insertText === "object"
        ? item.insertText.value
        : (item.insertText ?? (typeof item.label === "string" ? item.label : item.label.label))),
    insertTextRules:
      (snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : 0) |
      (item.keepWhitespace ? monaco.languages.CompletionItemInsertTextRule.KeepWhitespace : 0),
    range: range
      ? "inserting" in range
        ? { insert: toRange(range.inserting), replace: toRange(range.replacing) }
        : toRange(range)
      : fallbackRange,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map(toEdit),
    command: toCommand(item.command),
  };
}
function toDiagnostic(diagnostic: Diagnostic): monaco.editor.IMarkerData {
  const severity =
    [
      monaco.MarkerSeverity.Error,
      monaco.MarkerSeverity.Warning,
      monaco.MarkerSeverity.Info,
      monaco.MarkerSeverity.Hint,
    ][diagnostic.severity] ?? monaco.MarkerSeverity.Error;
  const code = diagnostic.code;
  return {
    ...toRange(diagnostic.range),
    severity,
    message: diagnostic.message,
    source: diagnostic.source,
    code:
      typeof code === "object"
        ? { value: String(code.value), target: toUri(code.target) }
        : code === undefined
          ? undefined
          : String(code),
    tags: diagnostic.tags ? [...diagnostic.tags] : undefined,
    relatedInformation: diagnostic.relatedInformation?.map((info) => ({
      ...toRange(info.location.range),
      resource: toUri(info.location.uri),
      message: info.message,
    })),
  };
}

function fromMarker(marker: monaco.editor.IMarkerData): Diagnostic {
  const severity =
    marker.severity === monaco.MarkerSeverity.Error
      ? DiagnosticSeverity.Error
      : marker.severity === monaco.MarkerSeverity.Warning
        ? DiagnosticSeverity.Warning
        : marker.severity === monaco.MarkerSeverity.Info
          ? DiagnosticSeverity.Information
          : DiagnosticSeverity.Hint;
  const diagnostic = new Diagnostic(fromRange(marker), marker.message, severity);
  diagnostic.source = marker.source;
  diagnostic.code =
    typeof marker.code === "object"
      ? { value: marker.code.value, target: Uri.from(marker.code.target) }
      : marker.code;
  diagnostic.tags = marker.tags;
  diagnostic.relatedInformation = marker.relatedInformation?.map(
    (info) =>
      new DiagnosticRelatedInformation(
        new Location(Uri.from(info.resource), fromRange(info)),
        info.message,
      ),
  );
  return diagnostic;
}

export interface DiagnosticCollection extends Iterable<[Uri, readonly Diagnostic[]]> {
  readonly name: string;
  set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void;
  set(entries: readonly [Uri, readonly Diagnostic[] | undefined][]): void;
  delete(uri: Uri): void;
  clear(): void;
  get(uri: Uri): readonly Diagnostic[] | undefined;
  has(uri: Uri): boolean;
  forEach(
    callback: (
      uri: Uri,
      diagnostics: readonly Diagnostic[],
      collection: DiagnosticCollection,
    ) => unknown,
    thisArg?: unknown,
  ): void;
  dispose(): void;
}

export class VscodeLanguagesCompatService {
  private readonly workspaceCompat = inject(VscodeWorkspaceCompatService);
  private readonly collectionOwners = new Set<string>();
  private readonly applyWorkspaceEditCommand = "_harness.vscode.applyWorkspaceEdit";
  private readonly queryModels = new Map<
    string,
    { model: monaco.editor.ITextModel; users: number }
  >();

  constructor() {
    const command = monaco.editor.registerCommand(
      this.applyWorkspaceEditCommand,
      (_accessor, apply: () => Promise<unknown>) => apply(),
    );
    onScopeDispose(() => command.dispose());
  }

  setLanguageConfiguration(
    language: string,
    configuration: LanguageConfigurationSnapshot,
  ): { dispose(): void } | undefined {
    if (!monaco.languages.getLanguages().some(({ id }) => id === language)) return undefined;
    return registerRuntimeLanguageConfiguration(language, configuration);
  }

  async getLanguages(): Promise<string[]> {
    return monaco.languages.getLanguages().map((language) => language.id);
  }

  executeSelectionRangeProvider(
    uri: Uri,
    positions: readonly Position[],
    snapshot?: TextDocumentSnapshot,
  ): Promise<Range[][]> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const chains = await this.monacoCommands.executeCommand<monaco.IRange[][]>(
          "_executeSelectionRangeProvider",
          resource,
          positions.map(({ line, character }) => ({ lineNumber: line + 1, column: character + 1 })),
        );
        return chains.map((chain) => chain.map(fromRange));
      },
      snapshot,
    );
  }

  async executeDocumentColorProvider(uri: Uri): Promise<ColorInformation[]> {
    const colors = await this.withQueryModel(uri, (resource) =>
      this.monacoCommands.executeCommand<
        { range: monaco.IRange; color: [number, number, number, number] }[]
      >("_executeDocumentColorProvider", resource),
    );
    return colors.map(({ range, color: [red, green, blue, alpha] }) => ({
      range: fromRange(range),
      color: { red, green, blue, alpha },
    }));
  }

  provideSemanticTokens(
    uri: Uri,
    query: SemanticTokensQuery,
    snapshot: TextDocumentSnapshot,
  ): Promise<monaco.languages.SemanticTokensLegend | number[] | undefined> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const command = `_${query.command}`;
        const range = "range" in query && query.range ? toRange(query.range) : undefined;
        if (query.command.endsWith("Legend")) {
          return this.monacoCommands.executeCommand<
            monaco.languages.SemanticTokensLegend | undefined
          >(command, resource, range);
        }
        const encoded = await this.monacoCommands.executeCommand<
          { buffer: Uint8Array } | undefined
        >(command, resource, range);
        return decodeFullSemanticTokens(encoded?.buffer);
      },
      snapshot,
    );
  }

  async executeColorPresentationProvider(
    color: Color,
    context: { uri: Uri; range: Range },
  ): Promise<ColorPresentation[]> {
    const presentations = await this.withQueryModel(context.uri, (resource) =>
      this.monacoCommands.executeCommand<monaco.languages.IColorPresentation[]>(
        "_executeColorPresentationProvider",
        [color.red, color.green, color.blue, color.alpha],
        { uri: resource, range: toRange(context.range) },
      ),
    );
    return presentations.map(({ label, textEdit, additionalTextEdits }) => ({
      label,
      textEdit: textEdit && fromEdit(textEdit),
      additionalTextEdits: additionalTextEdits?.map(fromEdit),
    }));
  }

  executeDocumentSymbolProvider(
    uri: Uri,
    snapshot?: TextDocumentSnapshot,
  ): Promise<DocumentSymbolQueryResult[]> {
    const convert = (symbol: monaco.languages.DocumentSymbol): DocumentSymbolQueryResult => ({
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail,
      containerName: symbol.containerName,
      range: fromRange(symbol.range),
      selectionRange: fromRange(symbol.selectionRange),
      children: symbol.children?.map(convert) ?? [],
    });
    return this.withQueryModel(
      uri,
      async (resource) => {
        const results = await this.monacoCommands.executeCommand<monaco.languages.DocumentSymbol[]>(
          "_executeDocumentSymbolProvider",
          resource,
        );
        return results.map(convert);
      },
      snapshot,
    );
  }

  executeFormattingProvider(
    uri: Uri,
    query: FormattingQuery,
    snapshot: TextDocumentSnapshot,
  ): Promise<TextEdit[] | undefined> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const model = monaco.editor.getModel(resource);
        if (!model) return undefined;
        const { tabSize, insertSpaces } = model.getOptions();
        const candidate = query.options as Partial<FormatOptions> | undefined;
        const options =
          typeof candidate === "object" &&
          typeof candidate?.tabSize === "number" &&
          typeof candidate.insertSpaces === "boolean"
            ? candidate
            : { tabSize, insertSpaces };
        const commands = {
          document: "_executeFormatDocumentProvider",
          range: "_executeFormatRangeProvider",
          onType: "_executeFormatOnTypeProvider",
        };
        const selection =
          query.kind === "range"
            ? [toRange(query.range)]
            : query.kind === "onType"
              ? [
                  { lineNumber: query.position.line + 1, column: query.position.character + 1 },
                  query.character,
                ]
              : [];
        const edits = await this.monacoCommands.executeCommand<
          monaco.languages.TextEdit[] | undefined
        >(commands[query.kind], resource, ...selection, options);
        return edits?.map(fromEdit);
      },
      snapshot,
    );
  }

  executeDefinitionProvider(
    kind: "definition" | "typeDefinition",
    uri: Uri,
    position: Position,
    snapshot?: TextDocumentSnapshot,
  ): Promise<(Location | LocationLink)[]> {
    const command =
      kind === "definition" ? "_executeDefinitionProvider" : "_executeTypeDefinitionProvider";
    return this.withQueryModel(
      uri,
      async (resource) => {
        const locations = await this.monacoCommands.executeCommand<monaco.languages.LocationLink[]>(
          command,
          resource,
          { lineNumber: position.line + 1, column: position.character + 1 },
        );
        const seen = new Set<string>();
        const results: (Location | LocationLink)[] = [];
        for (const { uri, range, targetSelectionRange, originSelectionRange } of locations) {
          const targetUri = documentUriForModel(uri);
          const targetRange = fromRange(range);
          const key = JSON.stringify([targetUri.toString(), targetRange]);
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(
            targetSelectionRange || originSelectionRange
              ? {
                  targetUri,
                  targetRange,
                  targetSelectionRange: targetSelectionRange && fromRange(targetSelectionRange),
                  originSelectionRange: originSelectionRange && fromRange(originSelectionRange),
                }
              : new Location(targetUri, targetRange),
          );
        }
        return results;
      },
      snapshot,
    );
  }

  private async withQueryModel<T>(
    uri: Uri,
    query: (resource: monaco.Uri) => Promise<T>,
    snapshot?: TextDocumentSnapshot,
  ): Promise<T> {
    const resource = toUri(uri);
    const key = resource.toString();
    let entry = this.queryModels.get(key);
    if (!entry) {
      if (monaco.editor.getModel(resource)) return query(resource);
      const document =
        this.workspaceCompat.textDocuments.value
          .find((document) => document.uri.toString() === key)
          ?.toJSON() ?? snapshot;
      if (!document) return query(resource);
      // File editor views use anonymous Monaco models, while provider selectors need the file URI.
      entry = {
        model: monaco.editor.createModel(document.text, document.languageId, resource),
        users: 0,
      };
      this.queryModels.set(key, entry);
    }
    entry.users++;
    try {
      return await query(resource);
    } finally {
      if (--entry.users === 0) {
        this.queryModels.delete(key);
        entry.model.dispose();
      }
    }
  }

  private get monacoCommands() {
    return StandaloneServices.get(ICommandService) as {
      executeCommand<T>(id: string, ...args: unknown[]): Promise<T>;
    };
  }

  private document(model: monaco.editor.ITextModel): TextDocumentData {
    return (
      this.workspaceCompat.textDocuments.value.find(
        (doc) => doc.uri.toString() === model.uri.toString(),
      ) ??
      new TextDocumentData({
        uri: model.uri.toJSON(),
        text: model.getValue(),
        version: model.getVersionId(),
        languageId: model.getLanguageId(),
        isDirty: false,
        eol: model.getEOL() === "\r\n" ? 2 : 1,
      })
    );
  }

  onDidChangeEditorDiagnostics(listener: (resources: readonly Uri[]) => void): Disposable {
    return monaco.editor.onDidChangeMarkers((resources) =>
      listener(resources.map((uri) => Uri.from(uri))),
    );
  }

  getEditorDiagnostics(resources?: readonly Uri[]): [Uri, Diagnostic[]][] {
    const grouped = new Map<string, [Uri, Diagnostic[]]>();
    for (const resource of resources ?? []) grouped.set(resource.toString(), [resource, []]);
    const markers = resources
      ? [...grouped.values()].flatMap(([resource]) =>
          monaco.editor.getModelMarkers({ resource: toUri(resource) }),
        )
      : monaco.editor.getModelMarkers({});
    for (const marker of markers) {
      if (this.collectionOwners.has(marker.owner)) continue;
      const uri = Uri.from(marker.resource);
      const key = uri.toString();
      let entry = grouped.get(key);
      if (!entry) {
        entry = [uri, []];
        grouped.set(key, entry);
      }
      entry[1].push(fromMarker(marker));
    }
    return [...grouped.values()];
  }

  createDiagnosticCollection(name = ""): DiagnosticCollection {
    const owner = `vscode-compat-${crypto.randomUUID()}`;
    const owners = this.collectionOwners;
    owners.add(owner);
    const entries = new Map<string, [Uri, readonly Diagnostic[]]>();
    let disposed = false;
    const ensureActive = () => {
      if (disposed) throw new Error("Diagnostic collection is disposed");
    };
    const render = (model: monaco.editor.ITextModel) =>
      monaco.editor.setModelMarkers(
        model,
        owner,
        (entries.get(model.uri.toString())?.[1] ?? []).map(toDiagnostic),
      );
    const update = (uri: Uri, diagnostics: readonly Diagnostic[] | undefined) => {
      const key = uri.toString();
      if (diagnostics === undefined) entries.delete(key);
      else entries.set(key, [uri, Object.freeze([...diagnostics])]);
      const model = monaco.editor.getModel(toUri(uri));
      if (model) render(model);
    };
    const subscription = monaco.editor.onDidCreateModel(render);
    const collection: DiagnosticCollection = {
      name,
      set(
        uriOrEntries: Uri | readonly [Uri, readonly Diagnostic[] | undefined][],
        diagnostics?: readonly Diagnostic[],
      ) {
        ensureActive();
        if (uriOrEntries === undefined) return collection.clear();
        if (!Array.isArray(uriOrEntries)) return update(uriOrEntries as Uri, diagnostics);
        const grouped = new Map<string, [Uri, Diagnostic[] | undefined]>();
        for (const [uri, list] of uriOrEntries) {
          const key = uri.toString();
          grouped.set(key, [
            uri,
            list === undefined ? undefined : [...(grouped.get(key)?.[1] ?? []), ...list],
          ]);
        }
        for (const [uri, list] of grouped.values()) update(uri, list);
      },
      delete(uri) {
        ensureActive();
        update(uri, undefined);
      },
      clear() {
        ensureActive();
        entries.clear();
        monaco.editor.removeAllMarkers(owner);
      },
      get(uri) {
        ensureActive();
        return entries.get(uri.toString())?.[1];
      },
      has(uri) {
        ensureActive();
        return entries.has(uri.toString());
      },
      forEach(callback, thisArg) {
        ensureActive();
        for (const [uri, diagnostics] of entries.values())
          callback.call(thisArg, uri, diagnostics, collection);
      },
      [Symbol.iterator]() {
        ensureActive();
        return entries.values();
      },
      dispose() {
        if (disposed) return;
        collection.clear();
        disposed = true;
        subscription.dispose();
        owners.delete(owner);
      },
    };
    return collection;
  }

  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: {
      provideCompletionItems(
        doc: TextDocumentData,
        position: Position,
        token: Token,
        context: { triggerKind: number; triggerCharacter?: string },
      ): Result<CompletionResult>;
      resolveCompletionItem?(item: CompletionData, token: Token): Result<CompletionData>;
    },
    ...triggerCharacters: string[]
  ): Disposable {
    const originalItems = new WeakMap<monaco.languages.CompletionItem, CompletionData>();
    return monaco.languages.registerCompletionItemProvider(toSelector(selector), {
      triggerCharacters,
      provideCompletionItems: async (model, position, context, token) => {
        const result = await provider.provideCompletionItems(
          this.document(model),
          fromPosition(position),
          token,
          context,
        );
        if (!result) return undefined;
        if (token.isCancellationRequested) {
          if (!Array.isArray(result)) (result as { dispose?(): void }).dispose?.();
          return undefined;
        }
        const items: readonly CompletionData[] = Array.isArray(result)
          ? result
          : (result as { items: readonly CompletionData[] }).items;
        const word = model.getWordAtPosition(position);
        const replace = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word?.startColumn ?? position.column,
          endColumn: word?.endColumn ?? position.column,
        };
        const range = { insert: { ...replace, endColumn: position.column }, replace };
        return {
          suggestions: items.map((item) => {
            const converted = toCompletion(item, range);
            originalItems.set(converted, item);
            return converted;
          }),
          incomplete:
            !Array.isArray(result) && Boolean((result as { isIncomplete?: boolean }).isIncomplete),
          dispose: Array.isArray(result) ? undefined : (result as { dispose?(): void }).dispose,
        };
      },
      resolveCompletionItem: provider.resolveCompletionItem
        ? async (item, token) => {
            const original = originalItems.get(item);
            if (!original) return item;
            const resolved = await provider.resolveCompletionItem!(original, token);
            if (!resolved || token.isCancellationRequested) return item;
            return toCompletion(resolved, item.range);
          }
        : undefined,
    });
  }

  registerHoverProvider(
    selector: DocumentSelector,
    provider: {
      provideHover(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<{
        contents: readonly (Documentation | { language: string; value: string })[] | Documentation;
        range?: RangeData;
      }>;
    },
  ): Disposable {
    return monaco.languages.registerHoverProvider(toSelector(selector), {
      provideHover: async (model, position, token) => {
        const hover = await provider.provideHover(
          this.document(model),
          fromPosition(position),
          token,
        );
        if (!hover) return undefined;
        const contents = (
          Array.isArray(hover.contents) ? hover.contents : [hover.contents]
        ) as readonly (Documentation | { language: string; value: string })[];
        const word = hover.range ? undefined : model.getWordAtPosition(position);
        return {
          range: hover.range
            ? toRange(hover.range)
            : new monaco.Range(
                position.lineNumber,
                word?.startColumn ?? position.column,
                position.lineNumber,
                word?.endColumn ?? position.column,
              ),
          contents: contents.map((value) => {
            if (typeof value === "string") return { value };
            if ("language" in value)
              return {
                value: new MarkdownString().appendCodeblock(value.value, value.language).value,
              };
            return toMarkdown(value) as monaco.IMarkdownString;
          }),
        };
      },
    });
  }

  executeHoverProvider(
    uri: Uri,
    position: PositionData,
    snapshot?: TextDocumentSnapshot,
  ): Promise<HoverQueryResult[]> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const hovers = await this.monacoCommands.executeCommand<monaco.languages.Hover[]>(
          "_executeHoverProvider",
          resource,
          { lineNumber: position.line + 1, column: position.character + 1 },
        );
        return hovers.map(({ contents, range }) => ({
          contents: contents.map(
            ({ value, isTrusted, supportHtml, supportThemeIcons, baseUri }) => ({
              value,
              isTrusted,
              supportHtml,
              supportThemeIcons,
              baseUri,
            }),
          ),
          range: range ? fromRange(range) : undefined,
        }));
      },
      snapshot,
    );
  }

  registerDefinitionProvider(
    selector: DocumentSelector,
    provider: {
      provideDefinition(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<LocationData | readonly LocationData[] | readonly LocationLinkData[]>;
    },
  ): Disposable {
    return monaco.languages.registerDefinitionProvider(toSelector(selector), {
      provideDefinition: async (model, position, token) => {
        return toLocations(
          await provider.provideDefinition(this.document(model), fromPosition(position), token),
        );
      },
    });
  }

  registerImplementationProvider(
    selector: DocumentSelector,
    provider: {
      provideImplementation(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<DefinitionResult>;
    },
  ): Disposable {
    return monaco.languages.registerImplementationProvider(toSelector(selector), {
      provideImplementation: async (model, position, token) =>
        toLocations(
          await provider.provideImplementation(this.document(model), fromPosition(position), token),
        ),
    });
  }

  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: {
      provideTypeDefinition(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<DefinitionResult>;
    },
  ): Disposable {
    return monaco.languages.registerTypeDefinitionProvider(toSelector(selector), {
      provideTypeDefinition: async (model, position, token) =>
        toLocations(
          await provider.provideTypeDefinition(this.document(model), fromPosition(position), token),
        ),
    });
  }

  registerSelectionRangeProvider(
    selector: DocumentSelector,
    provider: {
      provideSelectionRanges(
        doc: TextDocumentData,
        positions: readonly Position[],
        token: Token,
      ): Result<readonly SelectionRangeData[]>;
    },
  ): Disposable {
    return monaco.languages.registerSelectionRangeProvider(toSelector(selector), {
      provideSelectionRanges: async (model, positions, token) => {
        const result = await provider.provideSelectionRanges(
          this.document(model),
          positions.map(fromPosition),
          token,
        );
        return result?.map((selection) => {
          const chain: monaco.languages.SelectionRange[] = [];
          for (
            let current: SelectionRangeData | undefined = selection;
            current;
            current = current.parent
          )
            chain.push({ range: toRange(current.range) });
          return chain;
        });
      },
    });
  }

  registerLinkedEditingRangeProvider(
    selector: DocumentSelector,
    provider: {
      provideLinkedEditingRanges(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<{
        ranges: readonly RangeData[];
        wordPattern?: RegExp | { source: string; flags: string };
      }>;
    },
  ): Disposable {
    return monaco.languages.registerLinkedEditingRangeProvider(toSelector(selector), {
      provideLinkedEditingRanges: async (model, position, token) => {
        const result = await provider.provideLinkedEditingRanges(
          this.document(model),
          fromPosition(position),
          token,
        );
        return result
          ? {
              ranges: result.ranges.map(toRange),
              wordPattern: result.wordPattern
                ? new RegExp(result.wordPattern.source, result.wordPattern.flags)
                : undefined,
            }
          : undefined;
      },
    });
  }

  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: {
      provideOnTypeFormattingEdits(
        doc: TextDocumentData,
        position: Position,
        ch: string,
        options: FormatOptions,
        token: Token,
      ): Result<readonly TextEditData[]>;
    },
    firstTriggerCharacter: string,
    ...moreTriggerCharacters: string[]
  ): Disposable {
    return monaco.languages.registerOnTypeFormattingEditProvider(toSelector(selector), {
      autoFormatTriggerCharacters: [firstTriggerCharacter, ...moreTriggerCharacters],
      provideOnTypeFormattingEdits: async (model, position, ch, options, token) =>
        (
          await provider.provideOnTypeFormattingEdits(
            this.document(model),
            fromPosition(position),
            ch,
            options,
            token,
          )
        )?.map(toEdit),
    });
  }

  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: {
      onDidChangeSemanticTokens?: Event<void>;
      provideDocumentSemanticTokens(
        doc: TextDocumentData,
        token: Token,
      ): Result<{ data: readonly number[] | Uint32Array; resultId?: string }>;
      provideDocumentSemanticTokensEdits?(
        doc: TextDocumentData,
        previousResultId: string,
        token: Token,
      ): Result<
        | { data: readonly number[] | Uint32Array; resultId?: string }
        | {
            edits: readonly {
              start: number;
              deleteCount: number;
              data?: readonly number[] | Uint32Array;
            }[];
            resultId?: string;
          }
      >;
    },
    legend: { tokenTypes: string[]; tokenModifiers: string[] },
  ): Disposable {
    return monaco.languages.registerDocumentSemanticTokensProvider(toSelector(selector), {
      getLegend: () => legend,
      onDidChange: provider.onDidChangeSemanticTokens,
      provideDocumentSemanticTokens: async (model, previousResultId, token) => {
        const result =
          previousResultId && provider.provideDocumentSemanticTokensEdits
            ? await provider.provideDocumentSemanticTokensEdits(
                this.document(model),
                previousResultId,
                token,
              )
            : await provider.provideDocumentSemanticTokens(this.document(model), token);
        if (!result) return undefined;
        return "data" in result
          ? { data: Uint32Array.from(result.data), resultId: result.resultId }
          : {
              edits: result.edits.map((edit) => ({
                ...edit,
                data: edit.data ? Uint32Array.from(edit.data) : undefined,
              })),
              resultId: result.resultId,
            };
      },
      // The VS Code provider owns result IDs; this adapter retains no token cache.
      releaseDocumentSemanticTokens() {},
    });
  }

  registerDocumentRangeSemanticTokensProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentRangeSemanticTokens(
        doc: TextDocumentData,
        range: Range,
        token: Token,
      ): Result<{ data: readonly number[] | Uint32Array; resultId?: string }>;
    },
    legend: { tokenTypes: string[]; tokenModifiers: string[] },
  ): Disposable {
    return monaco.languages.registerDocumentRangeSemanticTokensProvider(toSelector(selector), {
      getLegend: () => legend,
      provideDocumentRangeSemanticTokens: async (model, range, token) => {
        const result = await provider.provideDocumentRangeSemanticTokens(
          this.document(model),
          fromRange(range),
          token,
        );
        return result
          ? { data: Uint32Array.from(result.data), resultId: result.resultId }
          : undefined;
      },
    });
  }

  registerInlineCompletionItemProvider(
    selector: DocumentSelector,
    provider: {
      provideInlineCompletionItems(
        doc: TextDocumentData,
        position: Position,
        context: { triggerKind: number; selectedCompletionInfo?: { range: Range; text: string } },
        token: Token,
      ): Result<readonly InlineCompletionData[] | { items: readonly InlineCompletionData[] }>;
    },
  ): Disposable {
    return monaco.languages.registerInlineCompletionsProvider(toSelector(selector), {
      provideInlineCompletions: async (model, position, context, token) => {
        const result = await provider.provideInlineCompletionItems(
          this.document(model),
          fromPosition(position),
          {
            triggerKind:
              context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit ? 0 : 1,
            selectedCompletionInfo: context.selectedSuggestionInfo
              ? {
                  range: fromRange(context.selectedSuggestionInfo.range),
                  text: context.selectedSuggestionInfo.text,
                }
              : undefined,
          },
          token,
        );
        const items: readonly InlineCompletionData[] = Array.isArray(result)
          ? result
          : ((result as { items?: readonly InlineCompletionData[] } | undefined)?.items ?? []);
        return {
          items: items.map((item) => ({
            insertText:
              typeof item.insertText === "string"
                ? item.insertText
                : { snippet: item.insertText.value },
            range: item.range ? toRange(item.range) : undefined,
            filterText: item.filterText,
            command: toCommand(item.command),
          })),
        };
      },
      freeInlineCompletions() {},
    });
  }

  registerCodeActionsProvider(
    selector: DocumentSelector,
    provider: {
      provideCodeActions(
        doc: TextDocumentData,
        range: Range,
        context: { diagnostics: readonly Diagnostic[]; only?: CodeActionKind; triggerKind: number },
        token: Token,
      ): Result<readonly (CodeActionData | Command)[] & { dispose?(): void }>;
      resolveCodeAction?(action: CodeActionData, token: Token): Result<CodeActionData>;
    },
    metadata?: {
      providedCodeActionKinds?: readonly { value: string }[];
      documentation?: readonly { kind: { value: string }; command: Command }[];
    },
  ): Disposable {
    const originals = new WeakMap<monaco.languages.CodeAction, CodeActionData>();
    const convert = (action: CodeActionData | Command): monaco.languages.CodeAction => {
      if (typeof action.command === "string")
        return { title: action.title, command: toCommand(action as Command) };
      const value = action as CodeActionData;
      const converted: monaco.languages.CodeAction = {
        title: value.title,
        kind: value.kind?.value,
        command: value.applyWorkspaceEdit
          ? {
              id: this.applyWorkspaceEditCommand,
              title: value.title,
              arguments: [value.applyWorkspaceEdit],
            }
          : toCommand(value.command),
        edit: toWorkspaceEdit(value.edit),
        diagnostics: value.diagnostics?.map(toDiagnostic),
        disabled: value.disabled?.reason,
        isPreferred: value.isPreferred,
      };
      originals.set(converted, value);
      return converted;
    };
    return monaco.languages.registerCodeActionProvider(
      toSelector(selector),
      {
        provideCodeActions: async (model, range, context, token) => {
          const diagnostics = context.markers.map(fromMarker);
          const actions = await provider.provideCodeActions(
            this.document(model),
            fromRange(range),
            {
              diagnostics,
              only: context.only ? new CodeActionKind(context.only) : undefined,
              triggerKind: context.trigger,
            },
            token,
          );
          if (token.isCancellationRequested) {
            actions?.dispose?.();
            return { actions: [], dispose() {} };
          }
          try {
            return {
              actions: (actions ?? []).map(convert),
              dispose: () => actions?.dispose?.(),
            };
          } catch (error) {
            actions?.dispose?.();
            throw error;
          }
        },
        resolveCodeAction: provider.resolveCodeAction
          ? async (action, token) => {
              const original = originals.get(action);
              if (!original) return action;
              const resolved = await provider.resolveCodeAction!(original, token);
              if (!resolved) return action;
              const converted = convert(resolved);
              if (resolved.applyWorkspaceEdit || original.applyWorkspaceEdit)
                action.command = converted.command;
              return converted;
            }
          : undefined,
      },
      {
        providedCodeActionKinds: metadata?.providedCodeActionKinds?.map((kind) => kind.value),
        documentation: metadata?.documentation?.map((entry) => ({
          kind: entry.kind.value,
          command: toCommand(entry.command)!,
        })),
      },
    );
  }

  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: {
      onDidChangeFoldingRanges?: Event<void>;
      provideFoldingRanges(
        doc: TextDocumentData,
        context: Record<string, never>,
        token: Token,
      ): Result<readonly { start: number; end: number; kind?: number }[]>;
    },
  ): Disposable {
    const kinds = [
      monaco.languages.FoldingRangeKind.Comment,
      monaco.languages.FoldingRangeKind.Imports,
      monaco.languages.FoldingRangeKind.Region,
    ];
    const adapter: monaco.languages.FoldingRangeProvider = {
      onDidChange: provider.onDidChangeFoldingRanges
        ? (listener) => provider.onDidChangeFoldingRanges!(() => listener(adapter))
        : undefined,
      provideFoldingRanges: async (model, _context, token) => {
        const result = await provider.provideFoldingRanges(this.document(model), {}, token);
        return (result ?? []).map((range) => ({
          start: range.start + 1,
          end: range.end + 1,
          kind: range.kind === undefined ? undefined : kinds[range.kind - 1],
        }));
      },
    };
    return monaco.languages.registerFoldingRangeProvider(toSelector(selector), adapter);
  }

  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentSymbols(
        doc: TextDocumentData,
        token: Token,
      ): Result<readonly SymbolData[] | readonly SymbolInformationData[]>;
    },
    metadata?: { label?: string },
  ): Disposable {
    const convert = (
      symbol: SymbolData | SymbolInformationData,
    ): monaco.languages.DocumentSymbol => {
      if ("location" in symbol)
        return {
          name: symbol.name || "!!MISSING: name!!",
          detail: "",
          containerName: symbol.containerName,
          kind: symbol.kind,
          tags: symbol.tags ? [...symbol.tags] : [],
          range: toRange(symbol.location.range),
          selectionRange: toRange(symbol.location.range),
        };
      return {
        name: symbol.name || "!!MISSING: name!!",
        detail: symbol.detail ?? "",
        kind: symbol.kind,
        tags: symbol.tags ? [...symbol.tags] : [],
        range: toRange(symbol.range),
        selectionRange: toRange(symbol.selectionRange),
        children: symbol.children?.map(convert),
      };
    };
    return monaco.languages.registerDocumentSymbolProvider(toSelector(selector), {
      displayName: metadata?.label,
      provideDocumentSymbols: async (model, token) => {
        const results = await provider.provideDocumentSymbols(this.document(model), token);
        const symbols = results?.map(convert);
        return results?.every((symbol) => "location" in symbol)
          ? nestDocumentSymbols(symbols ?? [])
          : symbols;
      },
    });
  }

  registerDocumentFormattingEditProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentFormattingEdits(
        doc: TextDocumentData,
        options: FormatOptions,
        token: Token,
      ): Result<readonly TextEditData[]>;
    },
  ): Disposable {
    return monaco.languages.registerDocumentFormattingEditProvider(toSelector(selector), {
      provideDocumentFormattingEdits: async (model, options, token) =>
        (
          (await provider.provideDocumentFormattingEdits(this.document(model), options, token)) ??
          []
        ).map(toEdit),
    });
  }

  registerReferenceProvider(
    selector: DocumentSelector,
    provider: {
      provideReferences(
        doc: TextDocumentData,
        position: Position,
        context: { includeDeclaration: boolean },
        token: Token,
      ): Result<readonly LocationData[]>;
    },
  ): Disposable {
    return monaco.languages.registerReferenceProvider(toSelector(selector), {
      provideReferences: async (model, position, context, token) =>
        (
          (await provider.provideReferences(
            this.document(model),
            fromPosition(position),
            context,
            token,
          )) ?? []
        ).map((location) => ({ uri: toUri(location.uri), range: toRange(location.range) })),
    });
  }

  registerRenameProvider(
    selector: DocumentSelector,
    provider: {
      provideRenameEdits(
        doc: TextDocumentData,
        position: Position,
        newName: string,
        token: Token,
      ): Result<WorkspaceEditData>;
      prepareRename?(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<RangeData | { range: RangeData; placeholder: string }>;
    },
  ): Disposable {
    return monaco.languages.registerRenameProvider(toSelector(selector), {
      provideRenameEdits: async (model, position, newName, token) =>
        toWorkspaceEdit(
          (await provider.provideRenameEdits(
            this.document(model),
            fromPosition(position),
            newName,
            token,
          )) ?? undefined,
        ),
      resolveRenameLocation: provider.prepareRename
        ? async (model, position, token) => {
            const result = await provider.prepareRename!(
              this.document(model),
              fromPosition(position),
              token,
            );
            if (!result) return undefined;
            const range = "range" in result ? result.range : result;
            return {
              range: toRange(range),
              text:
                "placeholder" in result
                  ? result.placeholder
                  : model.getValueInRange(toRange(range)),
            };
          }
        : undefined,
    });
  }

  executeSignatureHelpProvider(
    uri: Uri,
    position: Position,
    triggerCharacter?: string,
    snapshot?: TextDocumentSnapshot,
  ): Promise<SignatureHelpData | undefined> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const result = await this.monacoCommands.executeCommand<
          monaco.languages.SignatureHelp | undefined
        >(
          "_executeSignatureHelpProvider",
          resource,
          new monaco.Position(position.line + 1, position.character + 1),
          triggerCharacter,
        );
        return result && fromSignatureHelp(result);
      },
      snapshot,
    );
  }

  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: {
      provideSignatureHelp(
        doc: TextDocumentData,
        position: Position,
        token: Token,
        context: {
          triggerKind: number;
          triggerCharacter?: string;
          isRetrigger: boolean;
          activeSignatureHelp?: SignatureHelpData;
        },
      ): Result<SignatureHelpData>;
    },
    ...triggerCharactersOrMetadata: (
      | string
      | { triggerCharacters?: string[]; retriggerCharacters?: string[] }
    )[]
  ): Disposable {
    const metadata =
      typeof triggerCharactersOrMetadata[0] === "object"
        ? triggerCharactersOrMetadata[0]
        : { triggerCharacters: triggerCharactersOrMetadata as string[] };
    return monaco.languages.registerSignatureHelpProvider(toSelector(selector), {
      signatureHelpTriggerCharacters: metadata?.triggerCharacters,
      signatureHelpRetriggerCharacters: metadata?.retriggerCharacters,
      provideSignatureHelp: async (model, position, token, context) => {
        const active = context.activeSignatureHelp;
        const help = await provider.provideSignatureHelp(
          this.document(model),
          fromPosition(position),
          token,
          {
            ...context,
            activeSignatureHelp: active ? fromSignatureHelp(active) : undefined,
          },
        );
        if (!help) return undefined;
        return {
          value: {
            ...help,
            signatures: help.signatures.map((signature) => ({
              ...signature,
              documentation:
                signature.documentation === undefined
                  ? undefined
                  : toMarkdown(signature.documentation),
              parameters: (signature.parameters ?? []).map((parameter) => ({
                ...parameter,
                documentation:
                  parameter.documentation === undefined
                    ? undefined
                    : toMarkdown(parameter.documentation),
              })),
            })),
          },
          dispose() {},
        };
      },
    });
  }

  registerDocumentHighlightProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentHighlights(
        doc: TextDocumentData,
        position: Position,
        token: Token,
      ): Result<readonly { range: RangeData; kind?: number }[]>;
    },
  ): Disposable {
    return monaco.languages.registerDocumentHighlightProvider(toSelector(selector), {
      provideDocumentHighlights: async (model, position, token) =>
        (
          (await provider.provideDocumentHighlights(
            this.document(model),
            fromPosition(position),
            token,
          )) ?? []
        ).map((highlight) => ({ range: toRange(highlight.range), kind: highlight.kind })),
    });
  }

  executeLinkProvider(
    uri: Uri,
    linkResolveCount = 0,
    snapshot?: TextDocumentSnapshot,
  ): Promise<DocumentLinkQueryResult[]> {
    return this.withQueryModel(
      uri,
      async (resource) => {
        const model = monaco.editor.getModel(resource);
        if (!model) return [];
        const { linkProvider } = StandaloneServices.get(ILanguageFeaturesService) as {
          linkProvider: Parameters<typeof getLinks>[0];
        };
        const source = new monaco.CancellationTokenSource();
        let list: Awaited<ReturnType<typeof getLinks>> | undefined;
        try {
          list = await getLinks(linkProvider, model, source.token);
          for (let index = 0; index < Math.min(linkResolveCount, list.links.length); index++) {
            await list.links[index]!.resolve(source.token);
          }
          return list.links.map(({ range, url, tooltip }) => {
            let target: UriComponents | undefined;
            if (typeof url === "string") {
              try {
                target = Uri.parse(url, true).toJSON();
              } catch {}
            } else target = url?.toJSON();
            return { range: fromRange(range), target, tooltip };
          });
        } finally {
          source.dispose();
          list?.dispose();
        }
      },
      snapshot,
    );
  }

  registerDocumentLinkProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentLinks(
        doc: TextDocumentData,
        token: Token,
      ): Result<readonly DocumentLinkData[] & { dispose?(): void }>;
      resolveDocumentLink?(link: DocumentLinkData, token: Token): Result<DocumentLinkData>;
    },
  ): Disposable {
    const originals = new WeakMap<monaco.languages.ILink, DocumentLinkData>();
    const convert = (link: DocumentLinkData): monaco.languages.ILink => {
      const converted = {
        range: toRange(link.range),
        url: link.target ? toUri(link.target) : undefined,
        tooltip: link.tooltip,
      };
      originals.set(converted, link);
      return converted;
    };
    return monaco.languages.registerLinkProvider(toSelector(selector), {
      provideLinks: async (model, token) => {
        const links = await provider.provideDocumentLinks(this.document(model), token);
        return { links: (links ?? []).map(convert), dispose: () => links?.dispose?.() };
      },
      resolveLink: provider.resolveDocumentLink
        ? async (link, token) => {
            const original = originals.get(link);
            if (!original) return link;
            const resolved = await provider.resolveDocumentLink!(original, token);
            return resolved ? convert(resolved) : link;
          }
        : undefined,
    });
  }

  registerColorProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentColors(
        doc: TextDocumentData,
        token: Token,
      ): Result<readonly { range: RangeData; color: ColorData }[]>;
      provideColorPresentations(
        color: ColorData,
        context: { document: TextDocumentData; range: Range },
        token: Token,
      ): Result<readonly ColorPresentationData[]>;
    },
  ): Disposable {
    return monaco.languages.registerColorProvider(toSelector(selector), {
      provideDocumentColors: async (model, token) =>
        ((await provider.provideDocumentColors(this.document(model), token)) ?? []).map(
          (color) => ({ range: toRange(color.range), color: color.color }),
        ),
      provideColorPresentations: async (model, info, token) => {
        const presentations = await provider.provideColorPresentations(
          info.color,
          { document: this.document(model), range: fromRange(info.range) },
          token,
        );
        return presentations?.map(({ label, textEdit, additionalTextEdits }) => ({
          label,
          textEdit: textEdit && toEdit(textEdit),
          additionalTextEdits: additionalTextEdits?.map(toEdit),
        }));
      },
    });
  }

  registerInlayHintsProvider(
    selector: DocumentSelector,
    provider: {
      onDidChangeInlayHints?: Event<void>;
      provideInlayHints(
        doc: TextDocumentData,
        range: Range,
        token: Token,
      ): Result<readonly InlayHintData[] & { dispose?(): void }>;
      resolveInlayHint?(hint: InlayHintData, token: Token): Result<InlayHintData>;
    },
  ): Disposable {
    const originals = new WeakMap<monaco.languages.InlayHint, InlayHintData>();
    const convert = (hint: InlayHintData): monaco.languages.InlayHint => {
      const converted: monaco.languages.InlayHint = {
        position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
        label:
          typeof hint.label === "string"
            ? hint.label
            : hint.label.map((part) => ({
                label: part.value,
                tooltip: part.tooltip === undefined ? undefined : toMarkdown(part.tooltip),
                location: part.location
                  ? { uri: toUri(part.location.uri), range: toRange(part.location.range) }
                  : undefined,
                command: toCommand(part.command),
              })),
        kind: hint.kind,
        tooltip: hint.tooltip === undefined ? undefined : toMarkdown(hint.tooltip),
        textEdits: hint.textEdits?.map(toEdit),
        paddingLeft: hint.paddingLeft,
        paddingRight: hint.paddingRight,
      };
      originals.set(converted, hint);
      return converted;
    };
    return monaco.languages.registerInlayHintsProvider(toSelector(selector), {
      onDidChangeInlayHints: provider.onDidChangeInlayHints,
      provideInlayHints: async (model, range, token) => {
        const result = await provider.provideInlayHints(
          this.document(model),
          fromRange(range),
          token,
        );
        if (token.isCancellationRequested) {
          result?.dispose?.();
          return undefined;
        }
        return {
          hints: (result ?? []).map(convert),
          dispose() {
            result?.dispose?.();
          },
        };
      },
      resolveInlayHint: provider.resolveInlayHint
        ? async (hint, token) => {
            const original = originals.get(hint);
            if (!original) return hint;
            const resolved = await provider.resolveInlayHint!(original, token);
            return resolved ? convert(resolved) : hint;
          }
        : undefined,
    });
  }

  registerCodeLensProvider(
    selector: DocumentSelector,
    provider: {
      onDidChangeCodeLenses?: Event<void>;
      provideCodeLenses(
        doc: TextDocumentData,
        token: Token,
      ): Result<readonly CodeLensData[] & { dispose?(): void }>;
      resolveCodeLens?(lens: CodeLensData, token: Token): Result<CodeLensData>;
    },
  ): Disposable {
    const originals = new WeakMap<monaco.languages.CodeLens, CodeLensData>();
    const convert = (lens: CodeLensData): monaco.languages.CodeLens => {
      const converted = { range: toRange(lens.range), command: toCommand(lens.command) };
      originals.set(converted, lens);
      return converted;
    };
    const adapter: monaco.languages.CodeLensProvider = {
      onDidChange: provider.onDidChangeCodeLenses
        ? (listener) => provider.onDidChangeCodeLenses!(() => listener(adapter))
        : undefined,
      provideCodeLenses: async (model, token) => {
        const result = await provider.provideCodeLenses(this.document(model), token);
        return {
          lenses: (result ?? []).map(convert),
          dispose() {
            result?.dispose?.();
          },
        };
      },
      resolveCodeLens: provider.resolveCodeLens
        ? async (_model, lens, token) => {
            const original = originals.get(lens);
            if (!original) return lens;
            const resolved = await provider.resolveCodeLens!(original, token);
            return resolved ? convert(resolved) : lens;
          }
        : undefined,
    };
    return monaco.languages.registerCodeLensProvider(toSelector(selector), adapter);
  }

  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: {
      provideDocumentRangeFormattingEdits(
        doc: TextDocumentData,
        range: Range,
        options: FormatOptions,
        token: Token,
      ): Result<readonly TextEditData[]>;
    },
  ): Disposable {
    return monaco.languages.registerDocumentRangeFormattingEditProvider(toSelector(selector), {
      provideDocumentRangeFormattingEdits: async (model, range, options, token) =>
        (
          (await provider.provideDocumentRangeFormattingEdits(
            this.document(model),
            fromRange(range),
            options,
            token,
          )) ?? []
        ).map(toEdit),
    });
  }
}
