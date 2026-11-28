import { inject } from "@harness/di";
import type { StatusBarUpdate } from "./vscode/status-bar.ts";
import { RpcClientService } from "@harness/rpc";
import { StreamClientService } from "@harness/stream";
import { UiCommandsService } from "@harness/ui-commands";
import { VscodeConfigAdapter } from "./vscode-config.ts";
import { UiConfigService } from "@harness/ui-config";
import type { ConfigurationSnapshot } from "@harness/ui-config/configuration";
import {
  UiFilePickerService,
  type FilePickerDialogOptions,
  type FilePickerOpenOptions,
} from "@harness/ui-file-picker";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiOutputService } from "@harness/ui-output";
import {
  UiQuickInputService,
  type InputBoxOptions,
  type InputValidation,
  type QuickInputRequest,
  type QuickPickItem,
  type QuickPickOptions,
} from "@harness/ui-quick-input";
import { UiStatusBarService, type StatusBarItem } from "@harness/ui-status-bar";
import { UiStorageService } from "@harness/ui-storage";
import { UiTerminalService } from "@harness/ui-terminal";
import { UiWebviewService, WebviewTabDescriptor } from "@harness/ui-webview";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  Uri,
  VscodeEnvCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import {
  effectScope,
  onScopeDispose,
  reactive,
  shallowRef,
  watchEffect,
  type EffectScope,
} from "vue";
import { createMainThreadAuthentication } from "./main-thread/authentication.ts";
import { createMainThreadChatInputNotifications } from "./main-thread/chat-input.ts";
import { createMainThreadChatStatus } from "./main-thread/chat-status.ts";
import { createMainThreadComments } from "./main-thread/comments.ts";
import { createMainThreadEditor, serializeEditor } from "./main-thread/editor.ts";
import { createMainThreadOutput } from "./main-thread/output.ts";
import { createMainThreadDebug } from "./main-thread/debug.ts";
import { createMainThreadCommands } from "./main-thread/commands.ts";
import { createMainThreadFileDecorations } from "./main-thread/file-decorations.ts";
import { createMainThreadLanguages } from "./main-thread/languages.ts";
import { createMainThreadScm } from "./main-thread/scm.ts";
import { createMainThreadMemento } from "./main-thread/memento.ts";
import { createMainThreadProgress, type ProgressEntry } from "./main-thread/progress.ts";
import { createMainThreadTasks } from "./main-thread/tasks.ts";
import { createMainThreadTerminal } from "./main-thread/terminal.ts";
import { createMainThreadTree } from "./main-thread/tree.ts";
import { createMainThreadWebview } from "./main-thread/webview.ts";
import { createMainThreadWorkspace } from "./main-thread/workspace.ts";
import { encodeExtHostError } from "./wire-error.ts";
import { ExtHostRpcContract, ExtHostStreamContract } from "./rpc.ts";
import { ForegroundRegistrations } from "./foreground.ts";
import type { ShowMessageArgs } from "./vscode/messages.ts";

function requiresForeground(method: string, args: unknown[]): boolean {
  if (method === "commands.execute") return args[0] !== "setContext";
  if (method === "comments.reveal") return true;
  if (
    method === "workspace.applyEdit" ||
    method === "workspace.saveTextDocument" ||
    method === "workspace.save" ||
    method === "workspace.saveAll" ||
    method === "workspace.updateConfig"
  )
    return true;
  if (method.startsWith("editor.") || method.startsWith("env.")) return true;
  if (method === "auth.getSession") return !(args[2] as { silent?: boolean } | undefined)?.silent;
  return [
    "languages.executeDefinitionProvider",
    "languages.executeDocumentSymbolProvider",
    "languages.executeSignatureHelpProvider",
    "languages.executeDocumentColorProvider",
    "languages.executeColorPresentationProvider",
    "languages.executeLinkProvider",
    "languages.executeSelectionRangeProvider",
    "window.showTextDocument",
    "window.showVirtualTextDocument",
    "window.closeTabs",
    "window.closeTabGroups",
    "window.showQuickPick",
    "window.showInputBox",
    "window.showOpenDialog",
    "window.showSaveDialog",
    "window.showMessage",
    "languages.provideSemanticTokens",
    "terminal.create",
    "tasks.execute",
    "debug.runInTerminal",
    "languages.executeFormattingProvider",
  ].includes(method);
}

export class WorkspaceExtensionHostClient {
  private readonly foregroundState = shallowRef(false);
  private readonly rpc = inject(RpcClientService).use(ExtHostRpcContract);
  private readonly stream = inject(StreamClientService).use(ExtHostStreamContract);
  private readonly workspace = inject(UiWorkspaceService);
  private readonly tabs = inject(UiTabsService);
  private readonly workbench = inject(UiWorkbenchService);
  private readonly pageCommands = inject(UiCommandsService);
  private readonly registrations = new ForegroundRegistrations((error) => this.report(error));
  private readonly commands: Pick<UiCommandsService, "useCommand" | "execute" | "has"> = {
    useCommand: (id, handler, meta) => {
      onScopeDispose(this.registrations.use(() => this.pageCommands.useCommand(id, handler, meta)));
    },
    execute: <T>(id: string, ...args: unknown[]) => this.pageCommands.execute<T>(id, ...args),
    has: (id) => this.pageCommands.has(id),
  };
  private readonly config = new VscodeConfigAdapter(inject(UiConfigService));
  private configurationRevision = 0;
  private readonly notifications = inject(UiNotificationService);
  private messageLifetime = new AbortController();
  private readonly statusBar = inject(UiStatusBarService);
  private readonly outputService = inject(UiOutputService);
  private readonly quickInput = inject(UiQuickInputService);
  private readonly filePicker = inject(UiFilePickerService);
  private fileDialog?: AbortController;
  private readonly storage = inject(UiStorageService);
  private readonly terminal = inject(UiTerminalService);
  private readonly webviewStore = inject(UiWebviewService);
  private readonly languages = inject(VscodeLanguagesCompatService);
  private readonly windowCompat = inject(VscodeWindowCompatService);
  private readonly workspaceCompat = inject(VscodeWorkspaceCompatService);
  private readonly envCompat = inject(VscodeEnvCompatService);

  private readonly commandScopes = new Map<string, EffectScope>();
  private readonly mainCommands = createMainThreadCommands(this.commands);
  private readonly chatInput = createMainThreadChatInputNotifications((sessionId, command, args) =>
    this.rpc.executeCommand({ sessionId, command, args }),
  );
  readonly chatInputNotifications = this.chatInput.notifications;
  private readonly chatStatus = createMainThreadChatStatus();
  readonly chatStatusItems = this.chatStatus.items;
  readonly commandContexts = this.mainCommands.contexts;
  readonly comments = createMainThreadComments(
    this.windowCompat,
    (sessionId, command, args) => this.rpc.executeCommand({ sessionId, command, args }),
    () => this.workbench.open("ext-comments"),
    this.commandContexts,
    () => this.foreground,
  );
  private readonly statusItems = new Map<string, { item: StatusBarItem; scope: EffectScope }>();
  private readonly output: ReturnType<typeof createMainThreadOutput>;
  private readonly editor = createMainThreadEditor(this.windowCompat, this.workspaceCompat);
  private readonly customEditors = new Set<string>();
  private readonly virtualDocuments = new Set<string>();
  private readonly webviewViews = new Set<string>();
  private readonly uriHandlers = new Set<string>();
  private readonly handleWorkspace: ReturnType<typeof createMainThreadWorkspace>;
  private readonly handleBackgroundWorkspace: ReturnType<typeof createMainThreadWorkspace>;
  private readonly handleAuth = createMainThreadAuthentication(
    {
      showQuickPick: (items, options) =>
        this.foreground
          ? this.trackQuickInput(this.quickInput.showQuickPick(items, options))
          : Promise.resolve(undefined),
    },
    {
      executeCommand: (sessionId, command, args) =>
        this.rpc.executeCommand({ sessionId, command, args }),
    },
  );
  private readonly handleMemento = createMainThreadMemento(this.storage);
  private readonly scm = createMainThreadScm((command, args) => {
    void this.rpc.executeCommand({ sessionId: this.id, command, args });
  });
  readonly scmProviders = this.scm.providers;
  private readonly progress = createMainThreadProgress((id) => {
    void this.emit("__win.progress.cancel", id);
  });
  readonly progressEntries = this.progress.entries;
  private readonly handleLanguages = createMainThreadLanguages(
    this.languages,
    (sessionId, command, args, signal) =>
      this.rpc.executeCommand({ sessionId, command, args }, signal),
    (mount) => this.registrations.use(() => onScopeDispose(mount())),
  );
  private readonly webview = createMainThreadWebview(undefined, {
    show: (panel, column, preserveFocus) => {
      if (!this.foreground) return;
      this.webviewStore.panels.set(panel.id, panel);
      this.tabs.open(new WebviewTabDescriptor({ webviewId: panel.id, title: panel.title }), {
        preserveFocus,
        groupId: column && column > 0 ? this.tabs.groups.value[column - 1]?.id : undefined,
        split: column === -2 ? { direction: "right" } : undefined,
      });
    },
    dispose: (id) => {
      if (this.foreground) this.hideWebview(id);
    },
    title: (id, title) => {
      if (!this.foreground) return;
      for (const tab of this.tabs.tabs.values())
        if (tab.descriptor instanceof WebviewTabDescriptor && tab.descriptor.webviewId === id)
          tab.title = title;
    },
  });
  readonly webviewPanels = this.webview.panels;
  private readonly tree = createMainThreadTree(() => {
    if (this.foreground) this.workbench.open("ext-treeviews");
  });
  readonly treeViews = this.tree.views;
  private readonly fileDecorations = createMainThreadFileDecorations((sessionId, command, args) =>
    this.rpc.executeCommand({ sessionId, command, args }),
  );
  private readonly handleTerminal = createMainThreadTerminal(
    this.terminal,
    this.commands,
    (sessionId, command, args) => this.rpc.executeCommand({ sessionId, command, args }),
  );
  private readonly handleTasks = createMainThreadTasks(
    this.terminal,
    this.commands,
    (command, args) => this.rpc.executeCommand({ sessionId: this.id, command, args }),
  );
  private readonly handleDebug = createMainThreadDebug(
    this.terminal,
    this.commands,
    (sessionId, command, args) => this.rpc.executeCommand({ sessionId, command, args }),
  );
  private readonly controller = new AbortController();
  private started = false;
  private closing = false;
  private shutdown?: Promise<void>;
  private quickInputRequest?: { request: QuickInputRequest | null; id?: string };
  private readonly pendingEvents: [string, unknown][] = [];
  private readonly pendingActivations = new Set<string>();

  constructor(
    readonly id: string,
    private readonly workspaceKey: string,
    workspaceId: string,
    readonly roots: readonly string[],
    private readonly onStop: () => void,
  ) {
    const files = {
      activeRoots: { value: roots },
      getRoot: (root: string) => this.workspace.getRoot(root),
      resolveDocumentLanguage: (path: string, firstLine: string) =>
        this.workspaceCompat.resolveDocumentLanguage(path, firstLine),
      renameDocument: (root: string, from: string, to: string) =>
        this.workspaceCompat.renameDocument(root, from, to),
      saveFileEditor: (uri: Uri) => this.windowCompat.saveFileEditor(uri),
      saveAllFileEditors: () => this.windowCompat.saveAllFileEditors(),
    };
    this.handleWorkspace = createMainThreadWorkspace(files, this.config, this.workspaceCompat, () =>
      this.configurationSnapshot(),
    );
    this.handleBackgroundWorkspace = createMainThreadWorkspace(files, this.config);
    const workspace = this.workspace;
    this.output = createMainThreadOutput(
      this.outputService,
      {
        id,
        get label() {
          return workspace.getWorkspace(workspaceId)?.name ?? "Workspace";
        },
        detail: roots.join(", "),
      },
      () => this.foreground,
      this.workbench,
      this.tabs,
    );
  }

  private get foreground(): boolean {
    return this.foregroundState.value;
  }

  get isReady(): boolean {
    return this.started && !this.closing;
  }

  private trackQuickInput<T>(result: Promise<T>, id?: string): Promise<T> {
    const request = { request: this.quickInput.activeRequest.value, id };
    this.quickInputRequest = request;
    return result.finally(() => {
      if (this.quickInputRequest === request) this.quickInputRequest = undefined;
    });
  }

  ownsFile(path: string): boolean {
    return this.roots.some((root) => {
      const base = root.replace(/\/+$/, "");
      return path === base || path.startsWith(`${base}/`);
    });
  }

  setForeground(visible: boolean): void {
    if (visible === this.foreground) return;
    if (visible) this.messageLifetime = new AbortController();
    else this.messageLifetime.abort();

    this.foregroundState.value = visible;
    this.registrations.setVisible(visible);
    if (!visible) this.fileDialog?.abort();
    if (visible) {
      for (const panel of this.webviewPanels.values()) {
        this.webviewStore.panels.set(panel.id, panel);
        this.tabs.open(new WebviewTabDescriptor({ webviewId: panel.id, title: panel.title }), {
          preserveFocus: true,
        });
      }
      for (const id of this.webviewViews)
        void this.resolveWebviewView(id).catch((error) => this.report(error));
    } else {
      if (this.virtualDocuments.size) this.windowCompat.closeVirtualTextDocuments(this.id);
      if (this.quickInputRequest?.request === this.quickInput.activeRequest.value)
        this.quickInput.cancelActive();
      this.emit("__win.syncEditors", { visible: [] });
      this.emit("__win.syncTabGroups", { groups: [] });
      this.emit("__win.syncState", { active: false, focused: false });
      for (const id of this.webviewPanels.keys()) {
        this.hideWebview(id);
        this.emit(`__webview.state.${id}`, { active: false, visible: false });
      }
    }
  }

  private hideWebview(id: string): void {
    this.webviewStore.panels.delete(id);
    for (const tab of this.tabs.tabs.values())
      if (tab.descriptor instanceof WebviewTabDescriptor && tab.descriptor.webviewId === id)
        this.tabs.close(tab.tabId);
  }

  private async showFileDialog<T>(open: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.fileDialog?.abort();
    const controller = new AbortController();
    this.fileDialog = controller;
    try {
      return await open(controller.signal);
    } finally {
      if (this.fileDialog === controller) this.fileDialog = undefined;
    }
  }

  start(initialState: Record<string, unknown>, languages: Iterable<string>): void {
    void this.listen(initialState, languages);
  }

  private async ready(
    initialState: Record<string, unknown>,
    languages: Iterable<string>,
  ): Promise<void> {
    if (this.closing) return;
    await this.rpc.startSession({
      sessionId: this.id,
      workspaceRoots: [...this.roots],
      initialState,
    });
    if (this.closing) return;
    this.started = true;
    for (const [command, payload] of this.pendingEvents.splice(0))
      await this.emit(command, payload);
    this.activate("*");
    this.activate("onStartupFinished");
    for (const language of languages) this.pendingActivations.add(`onLanguage:${language}`);
    for (const event of this.pendingActivations) this.activate(event);
    this.pendingActivations.clear();
  }

  private async listen(
    initialState: Record<string, unknown>,
    languages: Iterable<string>,
  ): Promise<void> {
    try {
      for await (const event of this.stream.events(
        { sessionId: this.id },
        this.controller.signal,
      )) {
        if (this.controller.signal.aborted) break;
        if ("ready" in event) {
          void this.ready(initialState, languages).catch((error) => {
            this.report(error);
            if (!this.closing) this.onStop();
          });
        } else {
          void this.dispatchMainCall(
            event.sessionId,
            event.requestId,
            event.method,
            event.args,
          ).catch((error) => this.report(error));
        }
      }
    } catch (error) {
      this.report(error);
    } finally {
      if (!this.closing) this.onStop();
    }
  }

  private report(error: unknown): void {
    if (!this.closing && this.foreground)
      this.notifications.notify(
        `Extension host: ${error instanceof Error ? error.message : String(error)}`,
      );
  }

  activate(event: string): void {
    if (this.closing) return;
    if (!this.started) {
      this.pendingActivations.add(event);
      return;
    }
    void this.rpc
      .activateByEvent({ sessionId: this.id, event })
      .catch((error) => this.report(error));
  }

  configurationSnapshot(
    snapshot = this.config.snapshot(),
  ): ConfigurationSnapshot & { revision: number } {
    return { ...snapshot, revision: ++this.configurationRevision };
  }

  emit(command: string, payload: unknown): Promise<unknown> | undefined {
    if (this.closing) return;
    if (!this.started) {
      this.pendingEvents.push([command, payload]);
      return;
    }
    return this.rpc
      .executeCommand({ sessionId: this.id, command, args: [payload] })
      .catch((error) => this.report(error));
  }

  close(stopWorker = true): Promise<void> {
    return (this.shutdown ??= this.disposeHost(stopWorker));
  }

  private async disposeHost(stopWorker: boolean): Promise<void> {
    this.closing = true;
    this.setForeground(false);
    try {
      if (stopWorker && this.started) await this.rpc.stopSession({ sessionId: this.id });
    } finally {
      this.controller.abort();
      await this.handleAuth("auth.unregisterSession", [], this.id);
      for (const scope of this.commandScopes.values()) scope.stop();
      for (const entry of this.statusItems.values()) entry.scope.stop();
      this.progress.dispose();
      this.output.dispose();
      this.editor.dispose();
      this.scm.dispose();
      this.comments.dispose();
      this.handleLanguages.dispose();
      this.handleDebug.dispose();
      await this.handleTasks.reset();
      this.handleTasks.dispose();
      await this.handleTerminal.reset();
    }
  }

  postWebviewMessage(id: string, message: unknown): void {
    const sessionId = this.id;
    if (!this.foreground || !this.webviewPanels.has(id)) return;
    void this.rpc.executeCommand({
      sessionId,
      command: `__webview.message.${id}`,
      args: [message],
    });
  }

  cancelProgress(entry: ProgressEntry): void {
    if (this.foreground) this.progress.cancel(entry);
  }

  runChatInputAction(key: string, index: number): Promise<void> {
    return this.chatInput.invokeAction(key, index);
  }

  dismissChatInputNotification(key: string, automatic = false): Promise<void> {
    return this.chatInput.dismiss(key, automatic);
  }

  async openChatStatusLink(value: string): Promise<void> {
    const uri = Uri.parse(value);
    if (uri.scheme === "command") {
      const args: unknown = uri.query ? JSON.parse(decodeURIComponent(uri.query)) : [];
      if (!Array.isArray(args)) throw new TypeError("Command link arguments must be an array");
      await this.commands.execute(uri.path, ...args);
      return;
    }
    if (!["https", "http", "mailto"].includes(uri.scheme))
      throw new Error(`Unsupported status link: ${uri.scheme}`);
    await this.envCompat.openExternal(uri);
  }

  async getTreeChildren(viewId: string, elementId?: string): Promise<unknown[] | null> {
    const sessionId = this.id;
    const res = await this.rpc.executeCommand({
      sessionId,
      command: `__tree.getChildren.${viewId}`,
      args: elementId ? [elementId] : [],
    });
    return res === null || Array.isArray(res) ? res : [];
  }

  async setTreeCheckboxState(viewId: string, elementId: string, state: number): Promise<void> {
    const sessionId = this.id;
    await this.rpc.executeCommand({
      sessionId,
      command: `__tree.checkbox.${viewId}`,
      args: [[{ id: elementId, state }]],
    });
  }

  async setTreeSelection(viewId: string, elementIds: readonly string[]): Promise<boolean> {
    const accepted = await this.rpc.executeCommand({
      sessionId: this.id,
      command: `__tree.selection.${viewId}`,
      args: [elementIds],
    });
    return accepted === true;
  }

  getFileDecoration(uriPath: string) {
    return this.fileDecorations.getDecoration(uriPath);
  }

  async handleUri(uri: string): Promise<void> {
    const sessionId = this.id;
    await Promise.all(
      Array.from(this.uriHandlers).map((id) =>
        this.rpc.executeCommand({ sessionId, command: `__uri.handle.${id}`, args: [uri] }),
      ),
    );
  }

  async openCustomEditor(viewType: string, uriPath: string): Promise<void> {
    const sessionId = this.id;
    if (!this.customEditors.has(viewType)) return;
    await this.rpc.executeCommand({
      sessionId,
      command: `__customEditor.resolve.${viewType}`,
      args: [uriPath],
    });
  }

  async resolveWebviewView(viewId: string): Promise<void> {
    const sessionId = this.id;
    if (!this.foreground || !this.webviewViews.has(viewId)) return;
    const panelId = `wv-${viewId}`;
    if (this.webviewPanels.has(panelId)) return;
    this.webview.handle("webview.create", [panelId, viewId, viewId]);
    await this.rpc.executeCommand({
      sessionId,
      command: `__webviewView.resolve.${viewId}`,
      args: [panelId],
    });
  }

  private async dispatchMainCall(
    sessionId: string,
    requestId: string,
    method: string,
    args: unknown[],
  ): Promise<void> {
    try {
      const result = await this.handleMainCall(sessionId, method, args);
      await this.rpc.resolveMainCall({ sessionId, requestId, result });
    } catch (error) {
      await this.rpc.resolveMainCall({
        sessionId,
        requestId,
        ...encodeExtHostError(error),
      });
    }
  }

  private async handleMainCall(
    sessionId: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (!this.foreground && requiresForeground(method, args)) {
      throw new Error("This extension request requires its workspace to be active");
    }
    if (method.startsWith("chatInput.") && this.chatInput.handle(sessionId, method, args))
      return undefined;
    if (method.startsWith("chatStatus.") && this.chatStatus.handle(sessionId, method, args))
      return undefined;
    if (method.startsWith("comments.") && (await this.comments.handle(sessionId, method, args)))
      return undefined;
    if (method === "commands.execute") {
      const [command, ...rest] = args as [string, ...unknown[]];
      if (command === "vscode.open") {
        const rawUri = rest[0] as { scheme: string; path: string };
        await this.windowCompat.showTextDocument(
          Uri.from(rawUri),
          rest[1] as Parameters<VscodeWindowCompatService["showTextDocument"]>[1],
        );
        return undefined;
      }
      return await this.mainCommands.execute(command, rest);
    }
    if (method === "commands.getCommands")
      return this.foreground ? this.pageCommands.commands.value.map(({ id }) => id) : [];
    if (method.startsWith("memento.")) return this.handleMemento(this.workspaceKey, method, args);
    if (method.startsWith("scm.")) {
      return this.scm.handle(method, args);
    }
    if (method.startsWith("auth.")) {
      return await this.handleAuth(method, args, sessionId);
    }
    if (method.startsWith("workspace.")) {
      return await (this.foreground ? this.handleWorkspace : this.handleBackgroundWorkspace)(
        method,
        args,
      );
    }
    if (method.startsWith("languages.")) {
      return this.handleLanguages(sessionId, method, args);
    }
    if (method.startsWith("webview.")) {
      return this.webview.handle(method, args);
    }
    if (method.startsWith("tree.")) {
      return this.tree.handle(method, args);
    }
    if (this.fileDecorations.handle(sessionId, method, args)) {
      return undefined;
    }
    if (method === "window.registerUriHandler") {
      const [id] = args as [string];
      this.uriHandlers.add(id);
      return undefined;
    }
    if (method === "window.unregisterUriHandler") {
      const [id] = args as [string];
      this.uriHandlers.delete(id);
      return undefined;
    }
    if (method.startsWith("window.progress") && this.progress.handle(method, args))
      return undefined;
    if (method === "window.registerCustomEditorProvider") {
      const [viewType] = args as [string];
      this.customEditors.add(viewType);
      return undefined;
    }
    if (method === "window.unregisterCustomEditorProvider") {
      const [viewType] = args as [string];
      this.customEditors.delete(viewType);
      return undefined;
    }
    if (method === "window.registerWebviewViewProvider") {
      const [viewId] = args as [string];
      this.webviewViews.add(viewId);
      if (this.foreground)
        void this.resolveWebviewView(viewId).catch((error) => this.report(error));
      return undefined;
    }
    if (method === "window.unregisterWebviewViewProvider") {
      const [viewId] = args as [string];
      this.webviewViews.delete(viewId);
      return undefined;
    }
    if (method === "window.showTextDocument") {
      const [uri, options, preserveFocus] = args as [
        Parameters<typeof Uri.from>[0],
        Parameters<VscodeWindowCompatService["showTextDocument"]>[1],
        boolean?,
      ];
      const editor = await this.windowCompat.showTextDocument(
        Uri.from(uri),
        options ?? {},
        preserveFocus,
      );
      return serializeEditor(editor);
    }
    if (method === "window.showVirtualTextDocument") {
      const [documentId, snapshot, options = {}, preserveFocus = false] = args as [
        string,
        Parameters<VscodeWindowCompatService["showVirtualTextDocument"]>[2],
        Parameters<VscodeWindowCompatService["showVirtualTextDocument"]>[3]?,
        boolean?,
      ];
      this.virtualDocuments.add(documentId);
      try {
        const editor = await this.windowCompat.showVirtualTextDocument(
          this.id,
          documentId,
          snapshot,
          options,
          preserveFocus,
          () => {
            this.virtualDocuments.delete(documentId);
            if (this.isReady)
              void this.rpc
                .executeCommand({
                  sessionId: this.id,
                  command: "__ws.closeVirtualTextDocument",
                  args: [documentId, snapshot.uri],
                })
                .catch((error: unknown) => this.report(error));
          },
        );
        return serializeEditor(editor);
      } catch (error) {
        this.virtualDocuments.delete(documentId);
        throw error;
      }
    }
    if (method === "window.updateVirtualTextDocument") {
      const [documentId, snapshot] = args as [
        string,
        Parameters<VscodeWindowCompatService["updateVirtualTextDocument"]>[2],
      ];
      if (this.virtualDocuments.has(documentId))
        this.windowCompat.updateVirtualTextDocument(this.id, documentId, snapshot);
      return undefined;
    }
    if (method === "window.closeVirtualTextDocument") {
      const [documentId] = args as [string];
      if (this.virtualDocuments.has(documentId))
        this.windowCompat.closeVirtualTextDocuments(this.id, documentId);
      return undefined;
    }
    if (method === "window.closeTabs" || method === "window.closeTabGroups") {
      const [ids, preserveFocus] = args as [string[], boolean];
      return method === "window.closeTabs"
        ? this.windowCompat.closeTabs(ids, preserveFocus)
        : this.windowCompat.closeTabGroups(ids, preserveFocus);
    }
    if (method === "window.showOpenDialog") {
      return this.showFileDialog((signal) =>
        this.filePicker.pickOpen(args[0] as FilePickerOpenOptions, signal),
      );
    }
    if (method === "window.showSaveDialog") {
      return this.showFileDialog((signal) =>
        this.filePicker.pickSavePath(args[0] as FilePickerDialogOptions, signal),
      );
    }
    if (method === "window.showQuickPick") {
      const [id, rawItems, options] = args as [
        string,
        readonly QuickPickItem[],
        (QuickPickOptions & { canPickMany?: boolean })?,
      ];
      const items = rawItems.map((item, index) => ({ ...item, index }));
      const displayOptions = { matchOnDescription: false, ...options };
      const selected = await this.trackQuickInput(
        options?.canPickMany
          ? this.quickInput.showQuickPickMany(items, displayOptions)
          : this.quickInput.showQuickPick(items, displayOptions),
        id,
      );
      return Array.isArray(selected) ? selected.map((item) => item.index) : selected?.index;
    }
    if (method === "window.showInputBox") {
      const [id, options, validate] = args as [string, InputBoxOptions, boolean];
      const validateInput = validate
        ? async (value: string) =>
            (await this.rpc.executeCommand({
              sessionId,
              command: `__win.validateInput.${id}`,
              args: [value],
            })) as InputValidation
        : undefined;
      return await this.trackQuickInput(
        this.quickInput.showInputBox({
          ...options,
          validateInput,
          validateOnChange: validate,
        }),
        id,
      );
    }
    if (method === "window.cancelQuickInput") {
      const current = this.quickInputRequest;
      if (
        current &&
        current.id === args[0] &&
        current.request === this.quickInput.activeRequest.value
      )
        this.quickInput.cancelActive();
      return undefined;
    }
    if (method === "commands.register") {
      const [command] = args as [string];
      if (!this.commandScopes.has(command)) {
        const scope = effectScope();
        scope.run(() => {
          this.commands.useCommand(command, (...cmdArgs) =>
            this.rpc.executeCommand({ sessionId, command, args: cmdArgs }),
          );
        });
        this.commandScopes.set(command, scope);
      }
      return undefined;
    }
    if (method === "commands.unregister") {
      const [command] = args as [string];
      this.commandScopes.get(command)?.stop();
      this.commandScopes.delete(command);
      return undefined;
    }
    if (method === "window.showMessage") {
      const [severity, message, items, options] = args as ShowMessageArgs;
      const cancelAction = options?.modal
        ? items.findLastIndex((item) => typeof item !== "string" && item.isCloseAffordance)
        : -1;
      return this.notifications.showMessage(
        {
          message,
          severity: severity === "warn" ? "warning" : severity,
          actions: items.map((item) => (typeof item === "string" ? item : item.title)),
          modal: options?.modal,
          detail: options?.modal ? options.detail : undefined,
          cancelAction: cancelAction < 0 ? undefined : cancelAction,
        },
        this.messageLifetime.signal,
      );
    }
    if (method === "statusBar.create") {
      const [id, alignment, priority] = args as [string, "left" | "right", number];
      if (!this.statusItems.has(id)) {
        const scope = effectScope();
        const item = reactive<StatusBarItem>({ id, alignment, priority, text: "", visible: false });
        scope.run(() =>
          onScopeDispose(
            this.registrations.use(() => {
              const visibleItem = this.statusBar.useItem({ id, alignment, priority });
              watchEffect(() => Object.assign(visibleItem, item), { flush: "sync" });
            }),
          ),
        );
        this.statusItems.set(id, { item, scope });
      }
      return undefined;
    }
    if (method === "statusBar.update") {
      const [id, patch] = args as [string, StatusBarUpdate];
      const entry = this.statusItems.get(id);
      if (entry) {
        Object.assign(
          entry.item,
          Object.fromEntries(
            Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
          ),
        );
      }
      return undefined;
    }
    if (method === "statusBar.dispose") {
      const [id] = args as [string];
      this.statusItems.get(id)?.scope.stop();
      this.statusItems.delete(id);
      return undefined;
    }
    if (method.startsWith("output.")) return this.output.handle(method, args);
    if (method === "env.clipboard.readText") {
      return await this.envCompat.clipboard.readText();
    }
    if (method === "env.clipboard.writeText") {
      const [value] = args as [string];
      await this.envCompat.clipboard.writeText(value);
      return undefined;
    }
    if (method === "env.openExternal") {
      const [target] = args as [string];
      return await this.envCompat.openExternal(target);
    }
    if (method === "lm.registerMcpProvider" || method === "lm.didChangeMcpProvider") {
      const [id] = args as [string];
      void this.rpc.syncMcpProvider({ sessionId, providerId: id }).catch(() => {});
      return undefined;
    }
    if (method === "lm.unregisterMcpProvider") {
      const [id] = args as [string];
      void this.rpc.dropMcpProvider({ sessionId, providerId: id }).catch(() => {});
      return undefined;
    }
    if (
      method.startsWith("editor.") ||
      method === "window.createDecorationType" ||
      method === "window.disposeDecorationType"
    ) {
      return this.editor.handle(method, args);
    }
    if (await this.handleTerminal(sessionId, method, args)) {
      return undefined;
    }
    if (await this.handleTasks(method, args)) {
      return undefined;
    }
    const debugResult = (await this.handleDebug(sessionId, method, args)) as {
      handled: boolean;
      value: unknown;
    };
    if (debugResult.handled) {
      return debugResult.value;
    }
    return undefined;
  }
}
