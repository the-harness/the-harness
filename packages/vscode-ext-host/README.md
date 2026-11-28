```ts
interface ExtensionTreeMenuContext {
  readonly viewId: string;
  readonly node?: {
    readonly id: string;
    readonly label: string;
    readonly collapsibleState: number;
    readonly command?: { readonly command: string };
    readonly resourceUri?: { readonly path: string };
  };
  readonly expanded: boolean;
  readonly canCollapse: boolean;
  readonly open: () => Promise<void>;
  readonly toggle: () => void;
  readonly refresh: () => Promise<void>;
  readonly collapseAll: () => void;
}

interface CommentMenuContext {
  readonly thread: CommentThreadState;
  readonly comment?: CommentThreadState["comments"][number];
  readonly actions: readonly CommentAction[];
  readonly invoke: (command: string) => Promise<void>;
  readonly reveal: () => Promise<void>;
  readonly toggle: () => Promise<void>;
}

class ExtensionHostClientService {
  readonly treeMenu: Menu<ExtensionTreeMenuContext, "node" | "view">; // Scoped extension-tree menu contributions.
  readonly commentMenu: Menu<CommentMenuContext, "commands" | "thread">; // Scoped comment menu contributions.
}

interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly extensionPath: string;
  readonly main?: string;
  readonly packageJSON?: Record<string, unknown>;
  readonly extensionDependencies?: readonly string[];
  readonly activationEvents: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
  };
}

// 可拓展接口：注册扩展宿主生命周期 hook
interface ExtensionHostHooks {
  readonly sessionStopped: HookSlot<string>; // worker 结束；不代表 Chat 会话释放
}

class ExtensionHostService {
  readonly hooks: ExtensionHostHooks;
  constructor(options?: { readonly workerPath?: string; readonly extensionsDir?: string }); // worker 默认使用包内源码入口；目录依次使用 extensionsDir、HARNESS_VSCODE_EXTENSIONS_DIR、HARNESS_VSCODE_BUILTINS_DIR，未配置不加载扩展
  readonly dataChannels: { getDataChannel<T>(sessionId: string, channelId: string): { sendData(data: T): Promise<void> } }; // 向指定 worker 的扩展通道发送真实宿主数据
  readonly contributionsVersion: SyncedValueHost<string>; // 扫描或安装更新当前 DI 作用域的贡献版本
  installVsix(vsixPath: string, extensionsDir: string): Promise<ExtensionManifest>; // 同步运行中的 worker，并通知已连接 UI 刷新贡献
  scanExtensions(extensionsDir: string): Promise<ExtensionManifest[]>; // 累加或替换发现的扩展并刷新 UI；目录消失不卸载已导入项
  removeContentExtension(extensionId: string): Promise<boolean>; // 移除纯内容扩展的登记并刷新贡献。磁盘资源可在下次扫描时重新登记。
  removeExtension(extensionId: string): Promise<boolean>; // 停用扩展并释放其 subscriptions。其他已登记扩展依赖它时返回 false。
  getContributions(): Promise<ExtensionContributionSnapshot[]>; // 与启动、扫描、安装入口共享一次目录初始化，再读取本地语言、主题、图标和 snippet 资源
  startSession(sessionId: string, workspaceRoots: readonly string[], initialState?: Record<string, unknown>, signal?: AbortSignal): Promise<void>; // 启动指定 host，页面按有效 workspace 保留多个 host
  stopSession(sessionId: string): Promise<void>; // 等待 deactivate 和订阅释放，超时终止进程
  activateByEvent(sessionId: string, event: string): Promise<void>;
  syncMcpProvider(sessionId: string, providerId: string): Promise<void>; // 在服务端更新扩展 MCP 定义
  dropMcpProvider(sessionId: string, providerId: string): void; // 释放对应 provider 的服务器注册
  executeCommand<T = unknown>(sessionId: string, command: string, ...args: unknown[]): Promise<T>;
  executeCommandWithSignal<T = unknown>(sessionId: string, command: string, args: readonly unknown[], signal?: AbortSignal): Promise<T>; // Propagates cancellation to the worker request.
  registerMainThreadRouter(router: (sessionId: string, method: string, args: unknown[]) => Promise<{ handled: boolean; value?: unknown }>): () => void; // 服务端消费匹配请求，其余转发 UI
  onMainThreadCall(
    handler: (sessionId: string, method: string, args: unknown[], requestId: string) => Promise<unknown>,
  ): () => void;
  resolveMainCall(requestId: string, result?: unknown, error?: string | Error): void; // Completes a worker-to-main call with a result or a bridge error.
}

function useExtHostHandlers(): void; // Registers ExtHost RPC, streams, and StateSync using the scoped ExtensionHostService and SecretStorageService.
function copyFileSearchExecutable(directory: URL): Promise<void>; // Copies the platform's ripgrep binary into the web distribution.

const ExtHostStateSyncContract: StateSyncContract<{
  contributionsVersion: StateSyncValueEndpoint<z.ZodString, true>;
}>;

interface ExtHostMainCallEvent {
  sessionId: string;
  requestId: string;
  method: string;
  args: unknown[];
}

type ExtHostEvent = ExtHostMainCallEvent | { readonly ready: true };
function events(input: { sessionId: string }, signal?: AbortSignal): AsyncIterable<ExtHostEvent>; // ready 后可调用 startSession，关闭流释放 host

interface AuthenticationProvider { // 扩展实现的认证 provider
  readonly onDidChangeSessions: Event<{
    added?: readonly AuthenticationSession[];
    removed?: readonly AuthenticationSession[];
    changed?: readonly AuthenticationSession[];
  }>;
  getSessions(scopes: readonly string[] | undefined, options: AuthenticationProviderSessionOptions): PromiseLike<readonly AuthenticationSession[]>;
  createSession(scopes: readonly string[], options: AuthenticationProviderSessionOptions): PromiseLike<AuthenticationSession>;
  removeSession(sessionId: string): PromiseLike<void>;
}

interface AuthenticationProviderSessionOptions {
  account?: { readonly id: string; readonly label: string };
}

interface AuthenticationGetSessionOptions extends AuthenticationProviderSessionOptions {
  createIfNone?: boolean | { detail?: string };
  forceNewSession?: boolean | { detail?: string };
  silent?: boolean;
  clearSessionPreference?: boolean;
}

namespace authentication {
  const onDidChangeSessions: Event<{ provider: { id: string; label: string } }>;
  function registerAuthenticationProvider(id: string, label: string, provider: AuthenticationProvider, options?: { supportsMultipleAccounts?: boolean }): Disposable;
  function getSession(providerId: string, scopes: readonly string[], options: AuthenticationGetSessionOptions & { createIfNone: true | { detail?: string } }): Promise<AuthenticationSession>;
  function getSession(providerId: string, scopes: readonly string[], options: AuthenticationGetSessionOptions & { forceNewSession: true | { detail?: string } }): Promise<AuthenticationSession>;
  function getSession(providerId: string, scopes: readonly string[], options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined>;
  function getAccounts(providerId: string): Promise<readonly { id: string; label: string }[]>;
}

type McpServerDefinition = McpStdioServerDefinition | McpHttpServerDefinition;
type ProviderResult<T> = T | null | undefined | PromiseLike<T | null | undefined>;

interface McpServerDefinitionProvider<T extends McpServerDefinition = McpServerDefinition> { // 扩展实现的 MCP provider
  readonly onDidChangeMcpServerDefinitions?: Event<void>;
  provideMcpServerDefinitions(token: CancellationToken): ProviderResult<readonly T[]>;
  resolveMcpServerDefinition?(server: T, token: CancellationToken): ProviderResult<T>;
}

namespace lm {
  const onDidChangeChatModels: Event<void>;
  function selectChatModels(selector?: { id?: string; vendor?: string; family?: string; version?: string }): Promise<readonly LanguageModelChat[]>;
  function registerLanguageModelChatProvider(vendor: string, provider: LanguageModelChatProvider): Disposable;
  function registerMcpServerDefinitionProvider<T extends McpServerDefinition>(id: string, provider: McpServerDefinitionProvider<T>): Disposable;
  const tools: readonly { name: string; description: string; inputSchema?: object; tags: readonly string[] }[];
  function registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable;
  function invokeTool(name: string, options: { input: unknown; toolInvocationToken?: unknown }, token?: CancellationToken): Promise<LanguageModelToolResult>;
}

interface LanguageModelChat {
  readonly id: string;
  readonly vendor: string;
  readonly name: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  sendRequest(messages: LanguageModelChatMessage[], options?: LanguageModelChatRequestOptions, token?: CancellationToken): Promise<{ stream: AsyncIterable<LanguageModelResponsePart>; text: AsyncIterable<string> }>;
  countTokens(text: string | LanguageModelChatMessage, token?: CancellationToken): Promise<number>;
}
interface LanguageModelChatProvider<T = LanguageModelChatInformation> { // 扩展实现模型枚举、流式响应和实际 tokenizer
  readonly onDidChangeLanguageModelChatInformation?: Event<void>;
  provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): ProviderResult<T[]>;
  provideLanguageModelChatResponse(model: T, messages: readonly LanguageModelChatMessage[], options: LanguageModelChatRequestOptions, progress: { report(part: LanguageModelResponsePart): void }, token: CancellationToken): PromiseLike<void>;
  provideTokenCount(model: T, text: string | LanguageModelChatMessage, token: CancellationToken): PromiseLike<number>;
}

interface LanguageModelTool<T> { // 扩展实现的工具回调；需要确认的调用必须由确认 UI 承接
  invoke(options: { input: T; toolInvocationToken?: unknown }, token: CancellationToken): ProviderResult<LanguageModelToolResult>;
  prepareInvocation?(options: { input: T }, token: CancellationToken): ProviderResult<{ confirmationMessages?: unknown }>;
}

interface SecretStorage {
  readonly onDidChange: Event<{ readonly key: string }>; // Reports committed changes to workers of the same profile and extension.
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ExtensionContext {
  readonly secrets: SecretStorage; // Encrypted server-side storage shared by the extension's workspaces.
  readonly globalStorageUri: Uri;
  readonly storageUri: Uri | undefined; // 无工作区时为空
  readonly logUri: Uri;
  readonly environmentVariableCollection: EnvironmentVariableCollection;
}

interface EnvironmentVariableCollection extends Iterable<[string, EnvironmentVariableMutator]> {
  persistent: boolean;
  description: string | MarkdownString | undefined;
  replace(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
  append(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
  prepend(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
  get(variable: string): EnvironmentVariableMutator | undefined;
  delete(variable: string): void;
  clear(): void;
  forEach(callback: (variable: string, mutator: EnvironmentVariableMutator, collection: EnvironmentVariableCollection) => void, thisArg?: unknown): void;
  getScoped(scope: { workspaceFolder?: WorkspaceFolder }): EnvironmentVariableCollection;
}

interface TelemetrySender { // 扩展实现的 telemetry sender
  sendEventData(eventName: string, data?: Record<string, unknown>): void;
  sendErrorData(error: Error, data?: Record<string, unknown>): void;
  flush?(): void | PromiseLike<void>;
}

namespace env {
  function getDataChannel<T>(channelId: string): { readonly onDidReceiveData: Event<{ data: T }> };
  const power: Power; // Web 使用 VS Code BrowserPowerService 默认值；不伪造原生电源事件
  const isTelemetryEnabled: boolean;
  const logLevel: LogLevel;
  const onDidChangeTelemetryEnabled: Event<boolean>;
  const onDidChangeLogLevel: Event<LogLevel>;
  const isMeteredConnection: boolean;
  const onDidChangeMeteredConnection: Event<boolean>;
  function createTelemetryLogger(sender: TelemetrySender, options?: { additionalCommonProperties?: Record<string, unknown>; ignoreBuiltInCommonProperties?: boolean; ignoreUnhandledErrors?: boolean }): TelemetryLogger;
  function openExternal(target: Uri, options?: { allowContributedOpeners?: boolean | string }): Promise<boolean>;
}

interface Power {
  readonly onDidSuspend: Event<void>;
  readonly onDidResume: Event<void>;
  readonly onDidChangeOnBatteryPower: Event<boolean>;
  readonly onDidChangeThermalState: Event<"unknown" | "nominal" | "fair" | "serious" | "critical">;
  readonly onDidChangeSpeedLimit: Event<number>;
  readonly onWillShutdown: Event<void>;
  readonly onDidLockScreen: Event<void>;
  readonly onDidUnlockScreen: Event<void>;
  getSystemIdleState(idleThresholdSeconds: number): Promise<"active" | "idle" | "locked" | "unknown">;
  getSystemIdleTime(): Promise<number>;
  getCurrentThermalState(): Promise<"unknown" | "nominal" | "fair" | "serious" | "critical">;
  isOnBatteryPower(): Promise<boolean>;
  startPowerSaveBlocker(type: "prevent-app-suspension" | "prevent-display-sleep"): Promise<{ readonly id: number; readonly isStarted: boolean; dispose(): void }>;
}

namespace window {
  function createChatStatusItem(id: string): ChatStatusItem;
  function showQuickPick<T extends string | QuickPickItem>(items: readonly T[] | PromiseLike<readonly T[]>, options: QuickPickOptions & { canPickMany: true }, token?: CancellationToken): Promise<T[] | undefined>;
  function showQuickPick<T extends string | QuickPickItem>(items: readonly T[] | PromiseLike<readonly T[]>, options?: QuickPickOptions, token?: CancellationToken): Promise<T | undefined>;
  function showInputBox(options?: InputBoxOptions, token?: CancellationToken): Promise<string | undefined>; // The worker validates input as it changes.
  function createOutputChannel(name: string, languageId?: string): OutputChannel;
  function createOutputChannel(name: string, options: { log: true }): LogOutputChannel;
  function createWebviewPanel(viewType: string, title: string, showOptions?: number | { viewColumn?: number; preserveFocus?: boolean }, options?: WebviewOptions & { retainContextWhenHidden?: boolean; enableFindWidget?: boolean }): WebviewPanel;
  function registerWebviewPanelSerializer(viewType: string, serializer: WebviewPanelSerializer): Disposable;
  function registerProfileContentHandler(id: string, handler: ProfileContentHandler): Disposable;
  function registerExternalUriOpener(id: string, opener: ExternalUriOpener, metadata: { schemes: readonly string[]; label: string }): Disposable;
  function registerCustomEditorProvider(viewType: string, provider: CustomEditorProvider, options?: { webviewOptions?: { retainContextWhenHidden?: boolean; enableFindWidget?: boolean }; supportsMultipleEditorsPerDocument?: boolean }): Disposable;
  function showOpenDialog(options?: OpenDialogOptions): Promise<Uri[] | undefined>; // Selects resources on the host file system.
  function showSaveDialog(options?: SaveDialogOptions): Promise<Uri | undefined>; // Selects a host file path for saving.
  const linkPresentationRules: readonly { id: string; kind: string; uriPattern: RegExp }[];
  const onDidChangeLinkPresentationRules: Event<void>;
  function registerLinkPresentationProvider(id: string, provider: LinkPresentationProvider): Disposable;
  function createLinkPresentationWatcher(id: string, resource: Uri): LinkPresentationWatcher;
}

interface OpenDialogOptions {
  readonly defaultUri?: Uri;
  readonly openLabel?: string;
  readonly canSelectFiles?: boolean;
  readonly canSelectFolders?: boolean;
  readonly canSelectMany?: boolean;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
  readonly title?: string;
}
interface SaveDialogOptions {
  readonly defaultUri?: Uri;
  readonly saveLabel?: string;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
  readonly title?: string;
}

interface WebviewOptions { enableScripts?: boolean; localResourceRoots?: readonly Uri[] }
interface WebviewPanelSerializer { // 扩展实现的面板恢复回调
  deserializeWebviewPanel(panel: WebviewPanel, state: unknown): void | PromiseLike<void>;
}
interface CustomEditorProvider { // 扩展实现的 text editor 或 readonly custom document renderer
  resolveCustomTextEditor?(document: TextDocument, panel: WebviewPanel, token: CancellationToken): void | PromiseLike<void>;
  openCustomDocument?(uri: Uri, context: { backupId?: string; untitledDocumentData?: Uint8Array }, token: CancellationToken): CustomDocument | PromiseLike<CustomDocument>;
  resolveCustomEditor?(document: CustomDocument, panel: WebviewPanel, token: CancellationToken): void | PromiseLike<void>;
}
interface LinkPresentationProvider { // 扩展实现的声明式 URI 展示 provider
  provideLinkPresentationWatcher(resource: Uri, token: CancellationToken): LinkPresentationWatcher;
}
interface LinkPresentationWatcher {
  readonly presentation: unknown;
  readonly onDidChangePresentation: Event<void>;
  dispose(): void;
}
interface ProfileContentHandler { // 扩展实现的 profile 导入导出存储
  readonly name: string;
  readonly description?: string;
  readProfile(idOrUri: string | Uri, token: CancellationToken): PromiseLike<string | null>;
  saveProfile(name: string, content: string, token: CancellationToken): PromiseLike<{ id: string; link: Uri } | null>;
}
interface ExternalUriOpener { // 扩展实现的 HTTP 资源打开方式
  canOpenExternalUri(uri: Uri, token: CancellationToken): number | PromiseLike<number>;
  openExternalUri(uri: Uri, context: { sourceUri: Uri }, token: CancellationToken): void | PromiseLike<void>;
}
interface ChatOutputRenderer { // 扩展实现的输出渲染；宿主按 viewType 调用
  renderChatOutput(data: { mime: string; value: Uint8Array }, view: Pick<WebviewPanel, "webview" | "onDidDispose">, context: unknown, token: CancellationToken): PromiseLike<void>;
}
namespace chat {
  const onDidDisposeChatSession: Event<string>; // Inert while ChatParticipant support is disabled.
  function createInputNotification(id: string): ChatInputNotification;
  function createChatParticipant(id: string, handler: ChatRequestHandler): ChatParticipant; // Warns and returns an inert participant.
  function registerChatOutputRenderer(viewType: string, renderer: ChatOutputRenderer): Disposable;
}

interface ChatInputNotification {
  readonly id: string;
  severity: ChatInputNotificationSeverity;
  message: string;
  description?: string;
  actions: readonly { label: string; commandId: string; commandArgs?: unknown[] }[];
  dismissible: boolean;
  autoDismissOnMessage: boolean;
  sessionTypes?: readonly string[];
  show(): void;
  hide(): void;
  dispose(): void;
}

interface ChatStatusItem {
  readonly id: string;
  title: string | { label: string; link: string; helpText?: string };
  description: string;
  detail?: string;
  tooltip?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

namespace comments {
  function createCommentController(id: string, label: string): CommentController;
}

interface CommentController {
  readonly id: string;
  readonly label: string;
  readonly activeCommentThread: CommentThread | undefined;
  readonly activeComment: Comment | undefined;
  options?: { prompt?: string; placeHolder?: string };
  createCommentThread(uri: Uri, range: Range | undefined, comments: readonly Comment[]): CommentThread;
  dispose(): void;
}

interface CommentThread {
  readonly uri: Uri;
  range: Range | undefined;
  comments: readonly Comment[];
  collapsibleState: CommentThreadCollapsibleState;
  canReply: boolean | { name: string };
  contextValue?: string;
  label?: string;
  state?: CommentThreadState;
  reveal(comment?: Comment, options?: { focus?: CommentThreadFocus }): Promise<void>;
  hide(): Promise<void>;
  dispose(): void;
}

interface ChatParticipant {
  requestHandler: ChatRequestHandler;
  followupProvider?: ChatFollowupProvider;
  titleProvider?: ChatTitleProvider;
  summarizer?: ChatSummarizer;
  readonly onDidReceiveFeedback: Event<ChatResultFeedback>;
  readonly onDidPerformAction: Event<ChatUserActionEvent>;
  dispose(): void;
}
interface ChatResponseStream {
  push(part: ChatResponsePart): ChatResponseStream;
  markdown(value: string | MarkdownString): ChatResponseStream;
  thinkingProgress(delta: { text?: string | string[]; id?: string; metadata?: Record<string, unknown> }): ChatResponseStream;
}

namespace commands {
  function executeCommand(command: "vscode.executeSelectionRangeProvider", uri: Uri, positions: readonly Position[]): Promise<SelectionRange[]>;
  function executeCommand(command: "vscode.open", resource: Uri | string, columnOrOptions?: ViewColumn | TextDocumentShowOptions, label?: string): Promise<void>;
  function executeCommand(command: "vscode.prepareTypeHierarchy", uri: Uri, position: Position): Promise<TypeHierarchyItem[]>;
  function executeCommand(command: "vscode.provideSupertypes" | "vscode.provideSubtypes", item: TypeHierarchyItem): Promise<TypeHierarchyItem[]>;
}

namespace commands {
  function executeCommand(command: "vscode.executeFormatDocumentProvider", uri: Uri, options?: FormattingOptions): Promise<TextEdit[] | undefined>;
  function executeCommand(command: "vscode.executeFormatRangeProvider", uri: Uri, range: Range, options?: FormattingOptions): Promise<TextEdit[] | undefined>;
  function executeCommand(command: "vscode.executeFormatOnTypeProvider", uri: Uri, position: Position, character: string, options?: FormattingOptions): Promise<TextEdit[] | undefined>;
}

namespace l10n {
  const bundle: Record<string, string> | undefined; // Loaded from the calling extension's manifest-declared bundle directory.
  const uri: Uri | undefined; // URI of the loaded bundle.
  function t(message: string, ...args: (string | number | boolean)[]): string;
  function t(message: string, args: Record<string, string | number | boolean>): string;
  function t(options: { message: string; args?: readonly (string | number | boolean)[] | Record<string, string | number | boolean>; comment: string | readonly string[] }): string;
}
namespace window {
  const activeColorTheme: ColorTheme;
  const onDidChangeActiveColorTheme: Event<ColorTheme>;
  const state: WindowState;
  const onDidChangeWindowState: Event<WindowState>;
  const tabGroups: TabGroupsData;
  const onDidChangeTextEditorDiffInformation: Event<{ textEditor: HostTextEditor; diffInformation: HostTextEditor["diffInformation"] }>;
  const onDidChangeTextEditorVisibleRanges: Event<{ textEditor: HostTextEditor; visibleRanges: readonly Range[] }>;
  const onDidChangeTextEditorOptions: Event<{ textEditor: HostTextEditor; options: TextEditorOptions }>;
}

class HostTextEditor {
  options: TextEditorOptions;
  readonly diffInformation: readonly TextEditorDiffInformation[] | undefined; // Present only for a supplied diff snapshot.
  insertSnippet(snippet: SnippetString, location?: Position | Range | readonly Position[] | readonly Range[], options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): Promise<boolean>;
}

function readExtensionContributions(manifests: readonly ExtensionManifest[]): Promise<ExtensionContributionSnapshot[]>; // Reads declared resources within each extension directory.
```

```ts
namespace commands {
  function executeCommand(
    command: "vscode.executeDefinitionProvider" | "vscode.executeTypeDefinitionProvider",
    uri: Uri,
    position: Position,
  ): Promise<(Location | LocationLink)[]>;
  function executeCommand(command: "vscode.executeDocumentSymbolProvider", uri: Uri): Promise<(SymbolInformation & DocumentSymbol)[] | undefined>;
  function executeCommand(command: "vscode.executeHoverProvider", uri: Uri, position: Position): Promise<Hover[]>;
  function executeCommand(command: "vscode.executeDocumentColorProvider", uri: Uri): Promise<ColorInformation[]>;
  function executeCommand(command: "vscode.executeSignatureHelpProvider", uri: Uri, position: Position, triggerCharacter?: string): Promise<SignatureHelp | undefined>;
  function executeCommand(command: "vscode.executeColorPresentationProvider", color: Color, context: { uri: Uri; range: Range }): Promise<ColorPresentation[]>;
  function executeCommand(command: "vscode.executeLinkProvider", uri: Uri, linkResolveCount?: number): Promise<DocumentLink[]>;
}

// 可拓展接口：扩展提供工作区符号及按需补全位置的能力。
interface WorkspaceSymbolProvider<T extends SymbolInformation = SymbolInformation> {
  provideWorkspaceSymbols(query: string, token: CancellationToken): ProviderResult<T[]>;
  resolveWorkspaceSymbol?(symbol: T, token: CancellationToken): ProviderResult<T>;
}

namespace languages {
  function getLanguages(): Promise<string[]>; // 当前 Monaco 已注册的语言 ID。
  function match(selector: DocumentSelector, document: TextDocument): number; // 支持实际 notebook cell 的所属文档匹配。
  function setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable;
  function createDiagnosticCollection(name?: string): DiagnosticCollection;
  function getDiagnostics(uri: Uri): Diagnostic[]; // Includes diagnostics from the editor and extension collections.
  function getDiagnostics(): [Uri, Diagnostic[]][];
  const onDidChangeDiagnostics: Event<{ uris: readonly Uri[] }>;
  function createLanguageStatusItem(id: string, selector: DocumentSelector): LanguageStatusItem; // 使用状态栏展示当前匹配文档的状态。
  function registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
  function registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
  function registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
  function registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
  function registerImplementationProvider(selector: DocumentSelector, provider: ImplementationProvider): Disposable;
  function registerTypeDefinitionProvider(selector: DocumentSelector, provider: TypeDefinitionProvider): Disposable;
  function registerSelectionRangeProvider(selector: DocumentSelector, provider: SelectionRangeProvider): Disposable;
  function registerLinkedEditingRangeProvider(selector: DocumentSelector, provider: LinkedEditingRangeProvider): Disposable;
  function registerOnTypeFormattingEditProvider(selector: DocumentSelector, provider: OnTypeFormattingEditProvider, firstTriggerCharacter: string, ...moreTriggerCharacters: string[]): Disposable;
  function registerDocumentSemanticTokensProvider(selector: DocumentSelector, provider: DocumentSemanticTokensProvider, legend: SemanticTokensLegend): Disposable;
  function registerDocumentRangeSemanticTokensProvider(selector: DocumentSelector, provider: DocumentRangeSemanticTokensProvider, legend: SemanticTokensLegend): Disposable;
  function registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable; // resolve 和 command 参数保留原对象，列表释放时清理缓存。
  function registerWorkspaceSymbolProvider<T extends SymbolInformation>(provider: WorkspaceSymbolProvider<T>): Disposable; // vscode.executeWorkspaceSymbolProvider 查询并去重，不解析延迟位置。
  function registerCallHierarchyProvider(selector: DocumentSelector, provider: CallHierarchyProvider): Disposable;
  function registerTypeHierarchyProvider(selector: DocumentSelector, provider: TypeHierarchyProvider): Disposable;
  function registerMultiDocumentHighlightProvider(selector: DocumentSelector, provider: MultiDocumentHighlightProvider): Disposable; // 已有内部调用入口，尚未连接编辑器多文档高亮 UI。
  function registerDocumentPasteEditProvider(selector: DocumentSelector, provider: DocumentPasteEditProvider, metadata: DocumentPasteEditProviderMetadata): Disposable; // 内部调用入口支持文本；剪贴板 UI 尚未连接。
  function registerDocumentDropEditProvider(selector: DocumentSelector, provider: DocumentDropEditProvider, metadata?: DocumentDropEditProviderMetadata): Disposable; // 内部调用入口支持文本；拖拽 UI 尚未连接。
}

// 可拓展接口：扩展提供类型层级的根节点、父类型和子类型。
interface TypeHierarchyProvider {
  prepareTypeHierarchy(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<TypeHierarchyItem | TypeHierarchyItem[]>;
  provideTypeHierarchySupertypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
  provideTypeHierarchySubtypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
}

interface TreeDataProvider<T> {
  // 扩展实现的树节点提供者。
  readonly onDidChangeTreeData?: Event<T | undefined | null | void>;
  getTreeItem(element: T): ProviderResult<TreeItem>;
  getChildren(element?: T): ProviderResult<T[]>;
}

interface TreeView<T> {
  readonly selection: readonly T[];
  readonly onDidChangeSelection: Event<{ readonly selection: readonly T[] }>;
  readonly onDidChangeCheckboxState: Event<{ readonly items: readonly [T, TreeItemCheckboxState][] }>;
  dispose(): void;
}

namespace window {
  function registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): Disposable;
  function createTreeView<T>(viewId: string, options: { treeDataProvider: TreeDataProvider<T>; canSelectMany?: boolean }): TreeView<T>;
}

interface TreeViewState {
  readonly viewId: string;
  readonly canSelectMany?: boolean;
  selection?: string[];
  revision: number;
  focusRevision: number; // 焦点请求由树面板消费。
}

function createMainThreadTree(onFocus?: (viewId: string) => void): {
  readonly views: Map<string, TreeViewState>;
  handle(method: string, args: unknown[]): boolean;
};
```

```ts
type ConfigurationScope = Uri | TextDocument | WorkspaceFolder | { readonly uri?: Uri; readonly languageId: string } | null;

interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: ConfigurationScope): boolean;
}

interface WorkspaceConfiguration {
  get<T = unknown>(section: string, defaultValue?: T): T | undefined;
  has(section: string): boolean;
  inspect<T = unknown>(section: string): {
    key: string;
    defaultValue?: T;
    globalValue?: T;
    workspaceValue?: T;
    defaultLanguageValue?: T;
    globalLanguageValue?: T;
    workspaceLanguageValue?: T;
    languageIds?: string[];
  } | undefined;
  update(section: string, value: unknown, target?: ConfigurationTarget | boolean | null, overrideInLanguage?: boolean): Promise<void>; // Supports user and workspace language overrides.
  readonly [key: string]: unknown;
}

interface FileSystemWatcher extends Disposable {
  readonly ignoreCreateEvents: boolean;
  readonly ignoreChangeEvents: boolean;
  readonly ignoreDeleteEvents: boolean;
  readonly onDidCreate: Event<Uri>;
  readonly onDidChange: Event<Uri>;
  readonly onDidDelete: Event<Uri>;
}

namespace workspace {
  function getConfiguration(section?: string, scope?: ConfigurationScope): WorkspaceConfiguration;
  const onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
  const isTrusted: boolean;
  const onDidGrantWorkspaceTrust: Event<void>;
  const onDidChangeWorkspaceTrustedFolders: Event<void>;
  function isResourceTrusted(uri: Uri): Promise<boolean>;
  function registerFileSystemProvider(scheme: string, provider: FileSystemProvider, options?: { isCaseSensitive?: boolean; isReadonly?: boolean | MarkdownString }): Disposable;
  function registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProvider): Disposable;
  function createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents?: boolean,
    ignoreChangeEvents?: boolean,
    ignoreDeleteEvents?: boolean,
  ): FileSystemWatcher;
  const fs: FileSystem; // file 使用实际磁盘，其他 scheme 路由扩展 provider。二进制原样传递，支持 provider 间复制和移动。写文件和创建目录会补齐缺失的父目录。
  const onWillCreateFiles: Event<FileWillCreateEvent>;
  const onDidCreateFiles: Event<FileCreateEvent>;
  const onWillRenameFiles: Event<FileWillRenameEvent>;
  const onDidRenameFiles: Event<FileRenameEvent>;
  const onWillDeleteFiles: Event<FileWillDeleteEvent>;
  const onDidDeleteFiles: Event<FileDeleteEvent>;
  function save(uri: Uri): Promise<Uri | undefined>; // Saves a file open in a Workbench editor.
  function saveAll(includeUntitled?: boolean): Promise<boolean>; // Saves dirty file editors in the active workspace.
  function applyEdit(edit: WorkspaceEdit): Promise<boolean>; // 文本、文件和 notebook 操作有序执行；原始 fs 操作不发工作区文件事件。
  const notebookDocuments: readonly NotebookDocument[];
  const onDidOpenNotebookDocument: Event<NotebookDocument>;
  const onDidCloseNotebookDocument: Event<NotebookDocument>;
  const onDidChangeNotebookDocument: Event<NotebookDocumentChangeEvent>;
  const onWillSaveNotebookDocument: Event<NotebookDocumentWillSaveEvent>;
  const onDidSaveNotebookDocument: Event<NotebookDocument>;
  function registerNotebookSerializer(notebookType: string, serializer: NotebookSerializer, options?: NotebookDocumentContentOptions): Disposable;
  function openNotebookDocument(uri: Uri): Promise<NotebookDocument>;
  function openNotebookDocument(notebookType: string, content?: NotebookData): Promise<NotebookDocument>;
  function registerTimelineProvider(id: string, label: string, schemes: string | readonly string[], provider: TimelineProvider): Disposable; // 实际 provider 调用入口；尚无 timeline UI。
  function registerEditSessionIdentityProvider(scheme: string, provider: EditSessionIdentityProvider): Disposable;
  function registerTunnelProvider(provider: TunnelProvider, information?: TunnelInformation): Promise<Disposable>;
  function openTunnel(options: TunnelOptions): Promise<Tunnel>; // 调用真实 provider；登录和远端转发需要对应外部服务。
  const tunnels: Promise<readonly TunnelDescription[]>;
  const onDidChangeTunnels: Event<void>;
  function encode(content: string, options?: { readonly uri?: Uri; readonly encoding?: string }): Promise<Uint8Array>;
  function decode(content: Uint8Array, options?: { readonly uri?: Uri; readonly encoding?: string }): Promise<string>;
}

interface FileSystemProvider {
  // 扩展实现文件系统操作；未实现的操作返回 FileSystemError。
  readonly onDidChangeFile: Event<readonly FileChangeEvent[]>;
  watch(uri: Uri, options: { recursive: boolean; excludes: string[] }): Disposable;
  stat(uri: Uri): ProviderResult<FileStat>;
  readDirectory(uri: Uri): ProviderResult<[string, FileType][]>;
  readFile(uri: Uri): ProviderResult<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): ProviderResult<void>;
  createDirectory(uri: Uri): ProviderResult<void>;
  delete(uri: Uri, options: { recursive: boolean }): ProviderResult<void>;
  rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): ProviderResult<void>;
  copy?(source: Uri, destination: Uri, options: { overwrite: boolean }): ProviderResult<void>;
}

interface ProgressOptions {
  location: ProgressLocation | { viewId: string };
  title?: string;
  cancellable?: boolean;
}

namespace window {
  function withProgress<R>(
    options: ProgressOptions,
    task: (progress: { report(value: { message?: string; increment?: number }): void }, token: CancellationToken) => PromiseLike<R>,
  ): Promise<R>;
}

interface NotebookSerializer {
  // 扩展定义 notebook 的二进制序列化格式。
  deserializeNotebook(content: Uint8Array, token: CancellationToken): ProviderResult<NotebookData>;
  serializeNotebook(data: NotebookData, token: CancellationToken): ProviderResult<Uint8Array>;
}

interface TaskProvider {
  // 可拓展接口：扩展提供任务和按需解析任务。
  provideTasks(token: CancellationToken): ProviderResult<Task[]>;
  resolveTask?(task: Task, token: CancellationToken): ProviderResult<Task>;
}

namespace tasks {
  const taskExecutions: readonly TaskExecution[];
  const onDidStartTask: Event<TaskStartEvent>;
  const onDidEndTask: Event<TaskEndEvent>;
  const onDidStartTaskProcess: Event<TaskProcessStartEvent>;
  const onDidEndTaskProcess: Event<TaskProcessEndEvent>;
  function registerTaskProvider(type: string, provider: TaskProvider): Disposable; // 同一类型可独立注册多个 provider。
  function fetchTasks(filter?: { type?: string }): Promise<Task[]>;
  function executeTask(task: Task): Promise<TaskExecution>; // 实际 PTY 进程；支持命名 problem pattern/matcher 输出诊断。
}

namespace window {
  const terminals: readonly Terminal[];
  const activeTerminal: Terminal | undefined;
  const onDidOpenTerminal: Event<Terminal>;
  const onDidCloseTerminal: Event<Terminal>;
  const onDidChangeActiveTerminal: Event<Terminal | undefined>;
  const onDidChangeTerminalState: Event<Terminal>;
  function createTerminal(options: TerminalOptions): Terminal;
  function registerTerminalProfileProvider(id: string, provider: TerminalProfileProvider): Disposable; // 可调用注册的 profile 创建终端；尚无 profile 选择 UI。
  function registerTerminalCompletionProvider(provider: TerminalCompletionProvider, ...triggerCharacters: string[]): Disposable; // 实际 provider 调用；终端补全 UI 尚未连接。
}

interface StatusBarItem {
  readonly id: string;
  readonly alignment: StatusBarAlignment;
  readonly priority: number | undefined;
  name: string | undefined;
  text: string;
  tooltip: string | MarkdownString | undefined;
  color: string | ThemeColor | undefined;
  backgroundColor: ThemeColor | undefined;
  command: string | Command | undefined;
  accessibilityInformation: { label: string; role?: string } | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

namespace window {
  function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
  function createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
  function setStatusBarMessage(text: string, hideWhen?: number | PromiseLike<unknown>): Disposable;
}

interface DebugConfiguration {
  // 扩展可按调试器类型补充配置字段。
  type: string;
  name: string;
  request: string;
  [key: string]: unknown;
}

namespace debug {
  const activeDebugSession: DebugSession | undefined;
  const onDidStartDebugSession: Event<DebugSession>;
  const onDidTerminateDebugSession: Event<DebugSession>;
  const onDidReceiveDebugSessionCustomEvent: Event<DebugSessionCustomEvent>;
  const breakpoints: readonly Breakpoint[];
  function addBreakpoints(breakpoints: readonly Breakpoint[]): void;
  function removeBreakpoints(breakpoints: readonly Breakpoint[]): void;
  function registerDebugConfigurationProvider(type: string, provider: DebugConfigurationProvider, triggerKind?: DebugConfigurationProviderTriggerKind): Disposable;
  function registerDebugAdapterDescriptorFactory(type: string, factory: DebugAdapterDescriptorFactory): Disposable;
  function registerDebugAdapterTrackerFactory(type: string, factory: DebugAdapterTrackerFactory): Disposable;
  function startDebugging(folder: WorkspaceFolder | undefined, configuration: string | DebugConfiguration, options?: DebugSession | DebugSessionOptions): Promise<boolean>; // 标准 DAP TCP/pipe/executable/inline transport；调试 UI 尚未连接。
  function stopDebugging(session?: DebugSession): Promise<void>;
}

namespace commands {
  function executeCommand(command: "vscode.provideDocumentSemanticTokens", uri: Uri): Promise<SemanticTokens | undefined>;
  function executeCommand(command: "vscode.provideDocumentSemanticTokensLegend", uri: Uri): Promise<SemanticTokensLegend | undefined>;
  function executeCommand(command: "vscode.provideDocumentRangeSemanticTokens", uri: Uri, range: Range): Promise<SemanticTokens | undefined>;
  function executeCommand(command: "vscode.provideDocumentRangeSemanticTokensLegend", uri: Uri, range?: Range | null): Promise<SemanticTokensLegend | undefined>;
}

interface MessageItem { title: string; isCloseAffordance?: boolean }
interface MessageOptions { modal?: boolean; detail?: string }

namespace window {
  function showInformationMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  function showInformationMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  function showInformationMessage<T extends MessageItem>(message: string, ...items: T[]): Promise<T | undefined>;
  function showInformationMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  function showWarningMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  function showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  function showWarningMessage<T extends MessageItem>(message: string, ...items: T[]): Promise<T | undefined>;
  function showWarningMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  function showErrorMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  function showErrorMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  function showErrorMessage<T extends MessageItem>(message: string, ...items: T[]): Promise<T | undefined>;
  function showErrorMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
}
```
