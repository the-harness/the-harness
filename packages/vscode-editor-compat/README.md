```ts
interface TextDocumentChangeEvent {
  readonly document: TextDocument;
  readonly reason?: TextDocumentChangeReason;
  readonly contentChanges: readonly {
    readonly range: Range;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[];
}

class VscodeWorkspaceCompatService {
  readonly workspaceFolders: ComputedRef<readonly WorkspaceFolder[]>;
  readonly textDocuments: ComputedRef<readonly TextDocument[]>;
  readonly onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
  readonly onDidOpenTextDocument: Event<TextDocument>;
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
  readonly onDidSaveTextDocument: Event<TextDocument>;
  readonly onDidCloseTextDocument: Event<TextDocument>;
  readonly fs: {
    readFile(uri: Uri): Promise<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array): Promise<void>;
    readDirectory(uri: Uri): Promise<[string, number][]>;
    createDirectory(uri: Uri): Promise<void>;
    delete(uri: Uri): Promise<void>;
    rename(source: Uri, target: Uri): Promise<void>;
  };
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
  resolveDocumentLanguage(path: string, firstLine: string): string;
  openTextDocument(uriOrPath: Uri | string): Promise<TextDocument>;
  getTextDocument(path: string): TextDocument | undefined; // Preserves document identity.
  renameDocument(root: string, oldRelativePath: string, newRelativePath: string): Promise<void>; // Moves the working copy with its file.
  applyEdit(
    entries: readonly [Uri, readonly { range: Range; newText: string }[]][],
  ): Promise<boolean>; // Updates documents without saving.
}

interface TextDocumentShowOptions {
  readonly label?: string; // Title requested when opening a virtual resource.
  readonly viewColumn?: number;
  readonly preserveFocus?: boolean;
  readonly preview?: boolean;
  readonly selection?: Range;
}

class VscodeWindowCompatService {
  readonly windowState: ComputedRef<WindowState>;
  readonly onDidChangeWindowState: Event<WindowState>;
  readonly tabGroupsSnapshot: ComputedRef<TabGroupsSnapshot>;
  readonly tabGroups: TabGroupsData;
  saveFileEditor(uri: Uri): Promise<Uri | undefined>; // Saves an open file editor in the current workspace.
  saveAllFileEditors(): Promise<boolean>; // Saves each dirty, open file once and reports whether every save succeeded.
  closeTabs(ids: readonly string[], preserveFocus?: boolean): Promise<boolean>; // Confirms discarding dirty documents.
  closeTabGroups(ids: readonly string[], preserveFocus?: boolean): Promise<boolean>;
  readonly activeTextEditor: ComputedRef<TextEditor | undefined>;
  readonly visibleTextEditors: ComputedRef<readonly TextEditor[]>;
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>;
  readonly onDidChangeVisibleTextEditors: Event<readonly TextEditor[]>;
  readonly onDidChangeTextEditorOptions: Event<{
    textEditor: TextEditor;
    options: ResolvedTextEditorOptions;
  }>;
  readonly onDidChangeTextEditorSelection: Event<{
    textEditor: TextEditor;
    selections: readonly Selection[];
    kind?: TextEditorSelectionChangeKind;
  }>;
  readonly onDidChangeTextEditorVisibleRanges: Event<{
    textEditor: TextEditor;
    visibleRanges: readonly Range[];
  }>;
  registerMonacoEditor(path: string, editor: monaco.editor.IStandaloneCodeEditor): () => void;
  showTextDocument(
    documentOrUri: TextDocument | Uri,
    options?: TextDocumentShowOptions | number,
    preserveFocus?: boolean,
  ): Promise<TextEditor>;
  showVirtualTextDocument(
    owner: string,
    documentId: string,
    snapshot: TextDocumentSnapshot,
    options: TextDocumentShowOptions | number,
    preserveFocus: boolean,
    onClose: () => void,
  ): Promise<TextEditor>; // Opens or reuses the extension host's read-only editor.
  updateVirtualTextDocument(
    owner: string,
    documentId: string,
    snapshot: TextDocumentSnapshot,
  ): void;
  closeVirtualTextDocuments(owner: string, documentId?: string): void;
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType;
}

interface TextDocumentShowOptions {
  readonly viewColumn?: number;
  readonly preserveFocus?: boolean;
  readonly preview?: boolean;
  readonly selection?: Range;
}

class TextDocument extends TextDocumentData {
  constructor(document: EditorDocument, editorService: FileEditorService);
  refresh(closed?: boolean): void;
}

class TextEditor {
  constructor(
    documentSource: TextDocumentData | ComputedRef<TextDocumentData>,
    editor: monaco.editor.IStandaloneCodeEditor,
    decorationOptions?: (key: string) => DecorationRenderOptions | undefined,
  );
  readonly document: TextDocumentData;
  selection: Selection;
  selections: readonly Selection[];
  readonly visibleRanges: readonly Range[];
  readonly viewColumn: number | undefined;
  readonly diffInformation: undefined; // Single-text editors have no diff source.
  get options(): ResolvedTextEditorOptions;
  set options(value: TextEditorOptions);
  insertSnippet(
    snippet: SnippetString,
    location?: Position | Range | readonly Position[] | readonly Range[],
    options?: { undoStopBefore?: boolean; undoStopAfter?: boolean },
  ): Promise<boolean>;
  edit(
    callback: (builder: TextEditorEdit) => void,
    options?: { undoStopBefore?: boolean; undoStopAfter?: boolean },
  ): Promise<boolean>;
  revealRange(range: Range, revealType?: number): void;
  setDecorations(
    type: TextEditorDecorationType,
    rangesOrOptions: readonly (Range | DecorationOptions)[],
  ): void;
}

interface TextEditorEdit {
  replace(location: Range | Position, value: string): void;
  insert(location: Position, value: string): void;
  delete(location: Range): void;
  setEndOfLine(endOfLine: 1 | 2): void;
}

class VscodeCommandsCompatService {
  registerCommand(command: string, callback: (...args: any[]) => unknown): Disposable;
  executeCommand<T = unknown>(command: string, ...rest: any[]): Promise<T | undefined>;
  getCommands(filterInternal?: boolean): Promise<string[]>;
}

class VscodeEnvCompatService {
  readonly appName: string;
  readonly language: string;
  readonly clipboard: {
    readText(): Promise<string>;
    writeText(value: string): Promise<void>;
  };
  openExternal(target: Uri | string): Promise<boolean>;
}

type DocumentSelector = string | DocumentFilter | readonly (string | DocumentFilter)[];

interface DocumentFilter {
  readonly language?: string;
  readonly scheme?: string;
  readonly pattern?: string | RelativePattern;
  readonly notebookType?: string; // Notebook filters do not match text editors.
}

// Retains diagnostics for unopened documents; each collection owns its lifecycle.
type SemanticTokensQuery =
  | { command: "provideDocumentSemanticTokens" | "provideDocumentSemanticTokensLegend" }
  | { command: "provideDocumentRangeSemanticTokens"; range: RangeData }
  | { command: "provideDocumentRangeSemanticTokensLegend"; range?: RangeData };

interface DiagnosticCollection extends Iterable<[Uri, readonly Diagnostic[]]> {
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
  [Symbol.iterator](): Iterator<[Uri, readonly Diagnostic[]]>;
  dispose(): void;
}

type FormattingQuery =
  | { kind: "document"; options?: unknown }
  | { kind: "range"; range: RangeData; options?: unknown }
  | { kind: "onType"; position: PositionData; character: string; options?: unknown };

class VscodeLanguagesCompatService {
  setLanguageConfiguration(
    language: string,
    configuration: LanguageConfigurationSnapshot,
  ): { dispose(): void } | undefined;
  getLanguages(): Promise<string[]>;
  createDiagnosticCollection(name?: string): DiagnosticCollection;
  provideSemanticTokens(
    uri: Uri,
    query: SemanticTokensQuery,
    snapshot: TextDocumentSnapshot,
  ): Promise<SemanticTokensLegend | number[] | undefined>;
  onDidChangeEditorDiagnostics(listener: (resources: readonly Uri[]) => void): Disposable;
  getEditorDiagnostics(resources?: readonly Uri[]): [Uri, Diagnostic[]][]; // Reads Monaco's editor-owned markers.
  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider,
    ...triggerCharacters: string[]
  ): Disposable;
  registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
  registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
  registerImplementationProvider(
    selector: DocumentSelector,
    provider: ImplementationProvider,
  ): Disposable;
  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: TypeDefinitionProvider,
  ): Disposable;
  registerSelectionRangeProvider(
    selector: DocumentSelector,
    provider: SelectionRangeProvider,
  ): Disposable;
  registerLinkedEditingRangeProvider(
    selector: DocumentSelector,
    provider: LinkedEditingRangeProvider,
  ): Disposable;
  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: OnTypeFormattingEditProvider,
    firstTriggerCharacter: string,
    ...moreTriggerCharacters: string[]
  ): Disposable;
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
    legend: SemanticTokensLegend,
  ): Disposable;
  registerDocumentRangeSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentRangeSemanticTokensProvider,
    legend: SemanticTokensLegend,
  ): Disposable;
  registerInlineCompletionItemProvider(
    selector: DocumentSelector,
    provider: InlineCompletionItemProvider,
  ): Disposable;
  registerCodeActionsProvider(
    selector: DocumentSelector,
    provider: CodeActionProvider,
    metadata?: CodeActionProviderMetadata,
  ): Disposable; // Action results may supply applyWorkspaceEdit() and dispose().
  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: FoldingRangeProvider,
  ): Disposable;
  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: DocumentSymbolProvider,
    metadata?: { label?: string },
  ): Disposable;
  registerDocumentFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentFormattingEditProvider,
  ): Disposable;
  registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
  registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable;
  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: SignatureHelpProvider,
    ...triggersOrMetadata: (string | SignatureHelpProviderMetadata)[]
  ): Disposable;
  registerDocumentHighlightProvider(
    selector: DocumentSelector,
    provider: DocumentHighlightProvider,
  ): Disposable;
  registerDocumentLinkProvider(
    selector: DocumentSelector,
    provider: DocumentLinkProvider,
  ): Disposable; // Link result dispose is forwarded to Monaco.
  executeLinkProvider(
    uri: Uri,
    linkResolveCount?: number,
    snapshot?: TextDocumentSnapshot,
  ): Promise<DocumentLinkQueryResult[]>;
  registerColorProvider(selector: DocumentSelector, provider: DocumentColorProvider): Disposable;
  executeDocumentColorProvider(uri: Uri): Promise<ColorInformation[]>;
  executeDefinitionProvider(
    kind: "definition" | "typeDefinition",
    uri: Uri,
    position: Position,
    snapshot?: TextDocumentSnapshot,
  ): Promise<(Location | LocationLink)[]>;
  executeSelectionRangeProvider(
    uri: Uri,
    positions: readonly Position[],
    snapshot?: TextDocumentSnapshot,
  ): Promise<Range[][]>;
  executeDocumentSymbolProvider(
    uri: Uri,
    snapshot?: TextDocumentSnapshot,
  ): Promise<DocumentSymbolQueryResult[]>;
  executeHoverProvider(
    uri: Uri,
    position: PositionData,
    snapshot?: TextDocumentSnapshot,
  ): Promise<HoverQueryResult[]>;
  executeColorPresentationProvider(
    color: Color,
    context: { uri: Uri; range: Range },
  ): Promise<ColorPresentation[]>;
  executeSignatureHelpProvider(
    uri: Uri,
    position: Position,
    triggerCharacter?: string,
    snapshot?: TextDocumentSnapshot,
  ): Promise<SignatureHelpData | undefined>;
  registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable; // Hint lists can release resources via dispose().
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable;
  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentRangeFormattingEditProvider,
  ): Disposable;
  executeFormattingProvider(
    uri: Uri,
    query: FormattingQuery,
    snapshot: TextDocumentSnapshot,
  ): Promise<TextEdit[] | undefined>;
}

type DocumentLinkQueryResult = { range: Range; target?: UriComponents; tooltip?: string };

interface ExtensionContributionSnapshot {
  id: string;
  contributes: Record<string, unknown>;
  resources: Record<string, { contents: string; encoding: "utf8" | "base64"; mimeType: string }>;
  errors: { path: string; message: string }[];
}

function createExtensionContributions(
  snapshots: readonly ExtensionContributionSnapshot[],
  options?: {
    theme?: string;
    themeKind?: "dark" | "light";
    iconTheme?: string;
    colorTarget?: HTMLElement;
    getMaxTokenizationLineLength?: (languageId: string) => number | undefined; // Reads the active TextMate line limit for a language.
  },
): Promise<ExtensionContributions>;
interface ContributedColorTheme {
  readonly id: string;
  readonly uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light";
}
class ExtensionContributions {
  readonly issues: ContributionIssue[];
  readonly snippets: ContributedSnippet[];
  readonly availableThemes: { id: string; label: string; uiTheme: string; extensionId: string }[];
  readonly availableIconThemes: { id: string; label: string; extensionId: string }[];
  readonly themeName: string | undefined;
  readonly colorTheme: ContributedColorTheme | undefined; // The theme applied by this adapter.
  getLanguageId(path: string, firstLine?: string): string | undefined;
  getFileIconClass(
    path: string,
    options?: { folder?: boolean; expanded?: boolean; root?: boolean },
  ): string | undefined;
  setTheme(id: string): void;
  setIconTheme(id: string): void;
  dispose(): void;
}
function getContributedLanguageId(path: string, firstLine?: string): string | undefined;
function getContributedThemeName(): string | undefined;
function getContributedFileIconClass(
  path: string,
  options?: { folder?: boolean; expanded?: boolean; root?: boolean },
): string | undefined;
function queueContributionUpdate(update: () => Promise<void>): Promise<void>; // 串行替换页面共享的贡献资源，跨 client 实例保留顺序；单次失败不阻断后续更新
```
