import { inject, InstantiationService } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { VscodeConfigAdapter } from "./vscode-config.ts";
import { UiConfigService } from "@harness/ui-config";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiScmService } from "@harness/ui-scm";
import { UiSessionsService } from "@harness/ui-sessions";
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
  activeContributions,
  type ContributedColorTheme,
} from "@harness/vscode-editor-compat/contribution-state";
import { ColorThemeKind } from "@harness/vscode-types";
import { computed, effectScope, onScopeDispose, shallowRef, watch, type EffectScope } from "vue";
import { ClientContributions } from "./client-contributions.ts";
import { WorkspaceExtensionHostClient } from "./client-session.ts";
import { serializeEditor } from "./main-thread/editor.ts";
import { createExtensionTreeMenu, createCommentMenu } from "./menus.ts";
import type { ProgressEntry } from "./main-thread/progress.ts";
import { serializeDocumentChange } from "./main-thread/workspace.ts";
import { ExtHostRpcContract, ExtHostStateSyncContract } from "./rpc.ts";
import type { EditorDiagnosticsSnapshot } from "./vscode/editor-diagnostics.ts";
import type { ColorThemeSnapshot } from "./vscode/window.ts";

const contributedThemeKinds: Record<ContributedColorTheme["uiTheme"], ColorThemeKind> = {
  vs: ColorThemeKind.Light,
  "vs-dark": ColorThemeKind.Dark,
  "hc-black": ColorThemeKind.HighContrast,
  "hc-light": ColorThemeKind.HighContrastLight,
};

type NetworkInformation = EventTarget & {
  saveData?: boolean;
  metered?: boolean;
  effectiveType?: string;
};

type Host = {
  readonly key: string;
  readonly client: WorkspaceExtensionHostClient;
  readonly scope: EffectScope;
};

const emptyMap = new Map<never, never>();

export type { ExtensionTreeMenuContext, CommentMenuContext } from "./menus.ts";

export class ExtensionHostClientService {
  readonly treeMenu = createExtensionTreeMenu();
  readonly commentMenu = createCommentMenu();
  private readonly rpc = inject(RpcClientService).use(ExtHostRpcContract);
  private readonly contributionState = inject(StateSyncClientService).use(ExtHostStateSyncContract);
  private readonly instantiation = inject(InstantiationService);
  private readonly sessions = inject(UiSessionsService);
  private readonly workspace = inject(UiWorkspaceService);
  private readonly tabs = inject(UiTabsService);
  private readonly workbench = inject(UiWorkbenchService);
  private readonly config = new VscodeConfigAdapter(inject(UiConfigService));
  private readonly notifications = inject(UiNotificationService);
  private readonly scm = inject(UiScmService);
  private readonly webviewStore = inject(UiWebviewService);
  private readonly windowCompat = inject(VscodeWindowCompatService);
  private readonly languages = inject(VscodeLanguagesCompatService);
  private readonly workspaceCompat = inject(VscodeWorkspaceCompatService);
  private readonly envCompat = inject(VscodeEnvCompatService);
  private readonly hosts = new Map<string, Host>();
  private readonly active = shallowRef<Host>();
  private disposed = false;
  private readonly unregisterScm = this.scm.registerProviderSource(() =>
    Array.from(this.scmProviders.values()),
  );
  private readonly contributions = new ClientContributions(
    this.config,
    this.workbench,
    this.notifications,
    () => this.rpc.getContributions({}),
  );

  private readonly colorTheme = computed<ColorThemeSnapshot>(() => {
    const theme = activeContributions.value?.colorTheme;
    if (theme)
      return { id: theme.id, kind: contributedThemeKinds[theme.uiTheme] ?? ColorThemeKind.Dark };
    return {
      kind: this.workbench.theme.value === "light" ? ColorThemeKind.Light : ColorThemeKind.Dark,
    };
  });

  get commandContexts(): WorkspaceExtensionHostClient["commandContexts"] {
    return this.active.value?.client.commandContexts ?? emptyMap;
  }
  get comments() {
    return this.active.value?.client.comments;
  }
  get chatInputNotifications(): WorkspaceExtensionHostClient["chatInputNotifications"] {
    return this.active.value?.client.chatInputNotifications ?? emptyMap;
  }
  get chatStatusItems(): WorkspaceExtensionHostClient["chatStatusItems"] {
    return this.active.value?.client.chatStatusItems ?? emptyMap;
  }
  get scmProviders(): WorkspaceExtensionHostClient["scmProviders"] {
    return this.active.value?.client.scmProviders ?? emptyMap;
  }
  get treeViews(): WorkspaceExtensionHostClient["treeViews"] {
    return this.active.value?.client.treeViews ?? emptyMap;
  }
  get progressEntries(): ReadonlyMap<string, ProgressEntry> {
    return this.active.value?.client.progressEntries ?? emptyMap;
  }

  cancelProgress(entry: ProgressEntry): void {
    this.active.value?.client.cancelProgress(entry);
  }

  get webviewPanels(): WorkspaceExtensionHostClient["webviewPanels"] {
    return this.active.value?.client.webviewPanels ?? emptyMap;
  }

  constructor() {
    watch(
      () => this.contributionState.contributionsVersion.value,
      (version) => {
        if (version === undefined) return;
        void this.refreshContributions().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!this.disposed) this.notifications.notify(`Extension contributions: ${message}`);
        });
      },
      { immediate: true },
    );
    const stopWatch = watch(
      () => this.workspaceHostId(),
      (hostId) => this.selectWorkspace(hostId, this.workspace.activeRoots.value),
      { immediate: true },
    );

    const emitWs = (command: string, payload: unknown) => {
      const active = this.active.value;
      if (active && active.key === this.workspaceHostId())
        return active.client.emit(command, payload);
    };
    const subOpen = this.workspaceCompat.onDidOpenTextDocument(async (doc) => {
      const active = this.active.value;
      if (!active || active.key !== this.workspaceHostId()) return;
      await active.client.emit("__ws.onDidOpenTextDocument", doc.toJSON());
      active.client.activate(`onLanguage:${doc.languageId}`);
    });
    const subClose = this.workspaceCompat.onDidCloseTextDocument((doc) =>
      emitWs("__ws.onDidCloseTextDocument", doc.toJSON()),
    );
    const subSave = this.workspaceCompat.onDidSaveTextDocument((doc) =>
      emitWs("__ws.onDidSaveTextDocument", doc.toJSON()),
    );
    const subChange = this.workspaceCompat.onDidChangeTextDocument((e) =>
      emitWs("__ws.onDidChangeTextDocument", serializeDocumentChange(e)),
    );
    const subActiveEditor = this.windowCompat.onDidChangeActiveTextEditor((ed) =>
      emitWs("__win.onDidChangeActiveTextEditor", ed ? serializeEditor(ed) : undefined),
    );
    const subVisibleEditors = this.windowCompat.onDidChangeVisibleTextEditors((eds) => {
      const active = this.active.value;
      emitWs("__win.onDidChangeVisibleTextEditors", eds.map(serializeEditor));
      if (active)
        emitWs("__languages.syncEditorDiagnostics", this.editorDiagnostics(active.client));
    });
    const subEditorDiagnostics = this.languages.onDidChangeEditorDiagnostics((resources) => {
      const active = this.active.value;
      if (!active) return;
      const changes = this.editorDiagnostics(active.client, resources);
      if (changes.length) emitWs("__languages.updateEditorDiagnostics", changes);
    });
    const subSelection = this.windowCompat.onDidChangeTextEditorSelection((e) =>
      emitWs("__win.onDidChangeTextEditorSelection", {
        textEditor: serializeEditor(e.textEditor),
        kind: e.kind,
        selections: e.selections,
      }),
    );
    const subOptions = this.windowCompat.onDidChangeTextEditorOptions(({ textEditor }) => {
      const uri = textEditor.document.uri;
      if (uri.scheme === "file" && !this.active.value?.client.ownsFile(uri.fsPath)) return;
      return emitWs("__win.onDidChangeTextEditorOptions", {
        textEditor: serializeEditor(textEditor),
      });
    });
    const subVisibleRanges = this.windowCompat.onDidChangeTextEditorVisibleRanges((event) =>
      emitWs("__win.onDidChangeTextEditorVisibleRanges", {
        textEditor: serializeEditor(event.textEditor),
      }),
    );
    const stopFileChanges = this.workspace.onFileChange((event) => {
      for (const { client } of this.hosts.values())
        if (client.ownsFile(event.path)) client.emit("__ws.fileChanged", event);
    });
    const subFolders = this.workspaceCompat.onDidChangeWorkspaceFolders((event) =>
      emitWs("__ws.onDidChangeWorkspaceFolders", {
        ...event,
        folders: this.workspaceCompat.workspaceFolders.value,
      }),
    );
    watch(
      () => this.config.snapshot(),
      (snapshot) => {
        const active = this.active.value;
        if (active && active.key === this.workspaceHostId()) {
          active.client.emit("__config.sync", active.client.configurationSnapshot(snapshot));
          active.client.emit("__env.sync", this.environmentSnapshot());
        }
      },
      { deep: true },
    );
    watch(this.windowCompat.tabGroupsSnapshot, (snapshot) =>
      emitWs("__win.syncTabGroups", snapshot),
    );
    watch(this.windowCompat.windowState, (state) => emitWs("__win.syncState", state));
    watch([() => this.colorTheme.value.id, () => this.colorTheme.value.kind], () => {
      for (const { client } of this.hosts.values())
        client.emit("__win.syncColorTheme", this.colorTheme.value);
    });
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    const connectionChanged = () => emitWs("__env.sync", this.environmentSnapshot());
    const stopWebviewMessages = this.webviewStore.onMessage((id, message) =>
      this.postWebviewMessage(id, message),
    );
    const webviewSnapshots = new Map<string, string>();
    watch(
      () => ({
        host: this.active.value,
        groups: this.tabs.groups.value,
        tabs: [...this.tabs.tabs.values()],
        panels: [...this.webviewPanels.keys()],
      }),
      ({ host, groups, tabs, panels }, previous) => {
        if (host !== previous?.host) webviewSnapshots.clear();
        for (const id of panels) {
          const tab = tabs.find(
            (tab) =>
              tab.descriptor instanceof WebviewTabDescriptor && tab.descriptor.webviewId === id,
          );
          if (!tab) {
            if (webviewSnapshots.delete(id)) emitWs(`__webview.dispose.${id}`, undefined);
            continue;
          }
          const groupIndex = groups.findIndex((group) => group.tabIds.includes(tab.tabId));
          const group = groups[groupIndex];
          const state = {
            viewColumn: groupIndex + 1,
            visible: group?.activeTabId === tab.tabId,
            active: !!group?.isActive && group.activeTabId === tab.tabId,
          };
          const snapshot = JSON.stringify(state);
          if (webviewSnapshots.get(id) !== snapshot) {
            webviewSnapshots.set(id, snapshot);
            emitWs(`__webview.state.${id}`, state);
          }
        }
        for (const id of webviewSnapshots.keys())
          if (!panels.includes(id)) webviewSnapshots.delete(id);
      },
    );
    connection?.addEventListener("change", connectionChanged);

    onScopeDispose(() => {
      subOpen.dispose();
      subClose.dispose();
      subSave.dispose();
      subChange.dispose();
      subActiveEditor.dispose();
      subVisibleEditors.dispose();
      subEditorDiagnostics.dispose();
      subSelection.dispose();
      subVisibleRanges.dispose();
      subOptions.dispose();
      subFolders.dispose();
      stopFileChanges();
      stopWatch();
      this.disposed = true;
      for (const key of this.hosts.keys()) this.releaseHost(key, true);
      stopWebviewMessages();
      connection?.removeEventListener("change", connectionChanged);
      this.contributions.dispose();
    });
  }

  postWebviewMessage(id: string, message: unknown): void {
    this.active.value?.client.postWebviewMessage(id, message);
  }

  async runChatInputAction(key: string, index: number): Promise<void> {
    await this.active.value?.client.runChatInputAction(key, index);
  }

  async dismissChatInputNotification(key: string, automatic = false): Promise<void> {
    await this.active.value?.client.dismissChatInputNotification(key, automatic);
  }

  async openChatStatusLink(value: string): Promise<void> {
    await this.active.value?.client.openChatStatusLink(value);
  }

  async getTreeChildren(viewId: string, elementId?: string): Promise<unknown[] | null> {
    const client = this.active.value?.client;
    return client ? await client.getTreeChildren(viewId, elementId) : [];
  }

  async setTreeCheckboxState(viewId: string, elementId: string, state: number): Promise<void> {
    await this.active.value?.client.setTreeCheckboxState(viewId, elementId, state);
  }

  async setTreeSelection(viewId: string, elementIds: readonly string[]): Promise<boolean> {
    return (await this.active.value?.client.setTreeSelection(viewId, elementIds)) ?? false;
  }

  getFileDecoration(uriPath: string) {
    return this.active.value?.client.getFileDecoration(uriPath) ?? Promise.resolve(undefined);
  }

  async handleUri(uri: string): Promise<void> {
    await this.active.value?.client.handleUri(uri);
  }

  async openCustomEditor(viewType: string, uriPath: string): Promise<void> {
    await this.active.value?.client.openCustomEditor(viewType, uriPath);
  }

  async resolveWebviewView(viewId: string): Promise<void> {
    await this.active.value?.client.resolveWebviewView(viewId);
  }

  refreshContributions(): Promise<void> {
    return this.contributions.refresh();
  }

  private environmentSnapshot() {
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    const detected = !!(
      connection?.saveData ||
      connection?.metered ||
      connection?.effectiveType === "2g" ||
      connection?.effectiveType === "slow-2g"
    );
    const setting = this.config.get("network.meteredConnection", "auto");
    return {
      language: this.envCompat.language,
      isMeteredConnection: setting === "on" || (setting !== "off" && detected),
    };
  }

  private workspaceHostId(): string | undefined {
    const conversation = this.sessions.current.value;
    if (!conversation) return undefined;
    const roots = this.workspace.activeRoots.value.map((root) => Uri.file(root).toString());
    return `workspace:${JSON.stringify([conversation.workspaceId ?? "", roots])}`;
  }

  private selectWorkspace(key: string | undefined, roots: readonly string[]): void {
    const previous = this.active.value;
    if (previous?.key === key) return;
    previous?.client.setForeground(false);
    this.active.value = undefined;
    if (key === undefined) return;

    const existing = this.hosts.get(key);
    if (existing) {
      this.active.value = existing;
      existing.client.setForeground(true);
      this.updateWindow(existing.client);
      return;
    }

    const scope = effectScope(true);
    const client = scope.run(() =>
      this.instantiation.createInstance(
        WorkspaceExtensionHostClient,
        Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
          part.toString(16).padStart(8, "0"),
        ).join(""),
        key,
        this.sessions.current.value?.workspaceId ?? "",
        [...roots],
        () => this.releaseHost(key, false),
      ),
    )!;
    const host = { key, client, scope };
    this.hosts.set(key, host);
    this.active.value = host;
    client.setForeground(true);

    const window = this.windowSnapshot(client);
    client.start(
      {
        ...window,
        configuration: client.configurationSnapshot(),
        colorTheme: this.colorTheme.value,
        environment: this.environmentSnapshot(),
        webviewResourceBase: new URL(
          `/api/vscode-webview-resource/${encodeURIComponent(client.id)}/`,
          location.href,
        ).toString(),
      },
      new Set(window.documents.map((document) => document.languageId)),
    );
  }

  private releaseHost(key: string, stopWorker: boolean): void {
    const host = this.hosts.get(key);
    if (!host) return;
    this.hosts.delete(key);
    if (this.active.value === host) this.active.value = undefined;
    void host.client
      .close(stopWorker)
      .catch((error) => this.report(error))
      .finally(() => host.scope.stop());
  }

  private windowSnapshot(client: WorkspaceExtensionHostClient) {
    const matches = (document: { uri: Uri }) =>
      document.uri.scheme !== "file" || client.ownsFile(document.uri.fsPath);
    const active = this.windowCompat.activeTextEditor.value;
    return {
      documents: this.workspaceCompat.textDocuments.value
        .filter(matches)
        .map((doc) => doc.toJSON()),
      windowState: this.windowCompat.windowState.value,
      editorDiagnostics: this.editorDiagnostics(client),
      tabGroups: this.windowCompat.tabGroupsSnapshot.value,
      editors: {
        active: active && matches(active.document) ? serializeEditor(active) : undefined,
        visible: this.windowCompat.visibleTextEditors.value
          .filter((editor) => matches(editor.document))
          .map(serializeEditor),
      },
    };
  }

  private updateWindow(client: WorkspaceExtensionHostClient): void {
    const snapshot = this.windowSnapshot(client);
    client.emit("__ws.syncDocuments", snapshot.documents);
    client.emit("__win.syncEditors", snapshot.editors);
    client.emit("__languages.syncEditorDiagnostics", snapshot.editorDiagnostics);
    client.emit("__win.syncState", snapshot.windowState);
    client.emit("__win.syncTabGroups", snapshot.tabGroups);
    client.emit("__config.sync", client.configurationSnapshot());
    client.emit("__env.sync", this.environmentSnapshot());
    for (const document of snapshot.documents) client.activate(`onLanguage:${document.languageId}`);
  }

  private editorDiagnostics(
    client: WorkspaceExtensionHostClient,
    resources?: readonly Uri[],
  ): EditorDiagnosticsSnapshot {
    const visible = new Set(
      this.windowCompat.visibleTextEditors.value.map((editor) => editor.document.uri.toString()),
    );
    const isOwned = (uri: Uri) =>
      uri.scheme === "file" ? client.ownsFile(uri.fsPath) : visible.has(uri.toString());
    return this.languages
      .getEditorDiagnostics(resources?.filter(isOwned))
      .filter(([uri]) => isOwned(uri))
      .map<EditorDiagnosticsSnapshot[number]>(([uri, diagnostics]) => [
        uri.toJSON(),
        diagnostics.map((diagnostic) => ({
          ...diagnostic,
          code:
            typeof diagnostic.code === "object"
              ? { ...diagnostic.code, target: diagnostic.code.target.toJSON() }
              : diagnostic.code,
          relatedInformation: diagnostic.relatedInformation?.map(({ location, message }) => ({
            location: { uri: location.uri.toJSON(), range: location.range },
            message,
          })),
        })),
      ]);
  }

  private report(error: unknown): void {
    if (!this.disposed)
      this.notifications.notify(
        `Extension host: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
}
