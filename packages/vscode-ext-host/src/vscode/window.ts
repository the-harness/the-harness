import { createTabGroups } from "./tabs.ts";
import { createChatStatusApi } from "./chat-status.ts";
import { createFileDialogs } from "./file-dialogs.ts";
import {
  ColorThemeKind,
  type ColorTheme,
  type TextEditorOptions,
  type WindowState,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import { createTerminalApi } from "./terminal.ts";
import { createTreeApi } from "./tree.ts";
import { HostTextEditor, type EditorSnapshot } from "./editor.ts";
import { createMessagesApi } from "./messages.ts";
import { EventEmitter, Uri } from "./types.ts";
import { createOutputApi } from "./output.ts";
import { createStatusBarApi } from "./status-bar.ts";
import type { createEnvNamespace } from "./env.ts";
import { createWebviewApi } from "./webviews.ts";
import { createExternalUriOpenerApi } from "./external-openers.ts";
import { createLinkPresentationApi } from "./link-presentations.ts";
import { createProfileApi } from "./profiles.ts";
import { createWithProgress } from "./progress.ts";
import { createCustomEditorApi } from "./custom-editors.ts";
import type { createWorkspaceNamespace } from "./workspace.ts";
import { virtualDocumentViewIds } from "./document.ts";
import { createQuickInputApi } from "./quick-input.ts";

export type ColorThemeSnapshot = ColorTheme & { readonly id?: string };

export function createWindowNamespace(
  bridge: ExtHostBridge,
  environment: ReturnType<typeof createEnvNamespace>,
  openTextDocument: ReturnType<typeof createWorkspaceNamespace>["openTextDocument"],
) {
  const webviews = createWebviewApi(bridge);
  const tabGroups = createTabGroups(bridge);
  const links = createLinkPresentationApi(bridge);
  const stateEmitter = new EventEmitter<WindowState>();
  let state: WindowState = Object.freeze({ focused: false, active: false });
  bridge.commandHandlers.set("__win.syncState", (value) => {
    const next = value as WindowState;
    if (state.focused === next.focused && state.active === next.active) return;
    state = Object.freeze({ focused: next.focused, active: next.active });
    stateEmitter.fire(state);
  });
  const colorThemeEmitter = new EventEmitter<ColorTheme>();
  let colorTheme: ColorTheme = Object.freeze({ kind: ColorThemeKind.Dark });
  let colorThemeId: string | undefined;
  bridge.commandHandlers.set("__win.syncColorTheme", (value) => {
    const { id, kind } = value as ColorThemeSnapshot;
    if (id === colorThemeId && kind === colorTheme.kind) return;
    colorThemeId = id;
    colorTheme = Object.freeze({ kind });
    colorThemeEmitter.fire(colorTheme);
  });
  const statusBar = createStatusBarApi(bridge);
  const terminalApi = createTerminalApi(bridge);
  const treeApi = createTreeApi(bridge);
  let panelCounter = 0;
  const editorOptionsEmitter = new EventEmitter<{
    textEditor: HostTextEditor;
    options: TextEditorOptions;
  }>();
  const activeEditorEmitter = new EventEmitter<unknown>();
  const visibleEditorsEmitter = new EventEmitter<unknown[]>();
  const selectionEmitter = new EventEmitter<unknown>();
  const visibleRangesEmitter = new EventEmitter<{
    textEditor: HostTextEditor;
    visibleRanges: HostTextEditor["visibleRanges"];
  }>();
  const diffInformationEmitter = new EventEmitter<{
    textEditor: HostTextEditor;
    diffInformation: HostTextEditor["diffInformation"];
  }>();
  let currentActiveEditor: HostTextEditor | undefined;
  let currentVisibleEditors: HostTextEditor[] = [];
  const editors = new Map<string, HostTextEditor>();
  const reviveEditor = (snapshot: EditorSnapshot): HostTextEditor => {
    const key = Uri.from(snapshot.document.uri).toString();
    let editor = editors.get(key);
    const previousDiff = JSON.stringify(editor?.diffInformation);
    if (!editor || editor.document.isClosed) {
      editor = new HostTextEditor(bridge, snapshot);
      editors.set(key, editor);
    } else editor.update(snapshot);
    if (previousDiff !== JSON.stringify(editor.diffInformation))
      diffInformationEmitter.fire({ textEditor: editor, diffInformation: editor.diffInformation });
    return editor;
  };
  bridge.commandHandlers.set("__win.syncEditors", (value) => {
    const snapshot = value as { active?: EditorSnapshot; visible: EditorSnapshot[] };
    currentVisibleEditors = snapshot.visible.map(reviveEditor);
    currentActiveEditor = snapshot.active ? reviveEditor(snapshot.active) : undefined;
  });
  bridge.commandHandlers.set("__win.onDidChangeActiveTextEditor", (snapshot) => {
    currentActiveEditor = snapshot ? reviveEditor(snapshot as EditorSnapshot) : undefined;
    activeEditorEmitter.fire(currentActiveEditor);
  });
  bridge.commandHandlers.set("__win.onDidChangeVisibleTextEditors", (snapshots) => {
    currentVisibleEditors = (snapshots as EditorSnapshot[]).map(reviveEditor);
    visibleEditorsEmitter.fire(currentVisibleEditors);
  });
  bridge.commandHandlers.set("__win.onDidChangeTextEditorDiffInformation", (value) => {
    reviveEditor((value as { textEditor: EditorSnapshot }).textEditor);
  });
  bridge.commandHandlers.set("__win.onDidChangeTextEditorSelection", (value) => {
    const event = value as { textEditor: EditorSnapshot; kind?: number };
    const textEditor = reviveEditor(event.textEditor);
    selectionEmitter.fire({ textEditor, selections: textEditor.selections, kind: event.kind });
  });
  bridge.commandHandlers.set("__win.onDidChangeTextEditorOptions", (value) => {
    const textEditor = reviveEditor((value as { textEditor: EditorSnapshot }).textEditor);
    editorOptionsEmitter.fire({ textEditor, options: { ...textEditor.options } });
  });
  bridge.commandHandlers.set("__win.onDidChangeTextEditorVisibleRanges", (value) => {
    const textEditor = reviveEditor((value as { textEditor: EditorSnapshot }).textEditor);
    visibleRangesEmitter.fire({ textEditor, visibleRanges: textEditor.visibleRanges });
  });

  const api = {
    ...createChatStatusApi(bridge),
    ...terminalApi,
    get terminals() {
      return terminalApi.terminals;
    },
    get activeTerminal() {
      return terminalApi.activeTerminal;
    },
    ...treeApi,
    ...createOutputApi(bridge, environment),
    ...webviews,
    ...createCustomEditorApi(bridge, webviews, openTextDocument),
    ...createProfileApi(bridge),
    ...links,
    get linkPresentationRules() {
      return links.linkPresentationRules;
    },
    get activeTextEditor() {
      return currentActiveEditor;
    },
    get visibleTextEditors() {
      return currentVisibleEditors;
    },
    onDidChangeActiveTextEditor: activeEditorEmitter.event,
    onDidChangeVisibleTextEditors: visibleEditorsEmitter.event,
    onDidChangeTextEditorSelection: selectionEmitter.event,
    onDidChangeTextEditorOptions: editorOptionsEmitter.event,
    onDidChangeTextEditorVisibleRanges: visibleRangesEmitter.event,
    onDidChangeTextEditorDiffInformation: diffInformationEmitter.event,
    tabGroups,
    get state() {
      return state;
    },
    onDidChangeWindowState: stateEmitter.event,
    get activeColorTheme() {
      return colorTheme;
    },
    onDidChangeActiveColorTheme: colorThemeEmitter.event,
    async showTextDocument(
      uriOrDoc: Uri | { uri: Uri },
      options?: unknown,
      preserveFocus?: boolean,
    ) {
      const uri = uriOrDoc instanceof Uri ? uriOrDoc : uriOrDoc.uri;
      let snapshot: unknown;
      if (uri.scheme === "file") {
        snapshot = await bridge.callMain(
          "window.showTextDocument",
          uri.toJSON(),
          options,
          preserveFocus,
        );
      } else {
        const document = await openTextDocument(uri);
        const viewId = virtualDocumentViewIds.get(document) ?? crypto.randomUUID();
        virtualDocumentViewIds.set(document, viewId);
        snapshot = await bridge.callMain(
          "window.showVirtualTextDocument",
          viewId,
          document.toJSON(),
          options,
          preserveFocus,
        );
      }
      const editor = reviveEditor(snapshot as EditorSnapshot);
      if (!currentVisibleEditors.includes(editor)) currentVisibleEditors.push(editor);
      const keepFocus =
        typeof options === "number"
          ? preserveFocus
          : (options as { preserveFocus?: boolean } | undefined)?.preserveFocus;
      if (!keepFocus) currentActiveEditor = editor;
      return editor;
    },
    createTextEditorDecorationType(options: unknown) {
      const key = `decoration-${++panelCounter}`;
      void bridge.callMain("window.createDecorationType", key, options);
      return {
        key,
        dispose: () => {
          void bridge.callMain("window.disposeDecorationType", key);
        },
      };
    },
    setStatusBarMessage(text: string, hideWhen?: number | PromiseLike<unknown>) {
      return statusBar.setStatusBarMessage(text, hideWhen);
    },
    ...createFileDialogs(bridge),
    registerWebviewViewProvider(
      viewId: string,
      provider: { resolveWebviewView(webviewView: unknown): Promise<void> | void },
    ) {
      const cmd = `__webviewView.resolve.${viewId}`;
      bridge.commandHandlers.set(cmd, async (panelId: unknown) => {
        const view = {
          webview: {
            set html(val: string) {
              void bridge.callMain("webview.setHtml", String(panelId), val);
            },
            postMessage: (msg: unknown) =>
              bridge.callMain("webview.postMessage", String(panelId), msg),
          },
        };
        await provider.resolveWebviewView(view);
      });
      void bridge.callMain("window.registerWebviewViewProvider", viewId);
      return {
        dispose() {
          bridge.commandHandlers.delete(cmd);
          void bridge.callMain("window.unregisterWebviewViewProvider", viewId);
        },
      };
    },
    withProgress: createWithProgress(bridge),
    registerUriHandler(handler: { handleUri(uri: Uri): unknown }) {
      const id = `uh-${++panelCounter}`;
      const cmd = `__uri.handle.${id}`;
      bridge.commandHandlers.set(cmd, (rawUri: unknown) =>
        handler.handleUri(Uri.parse(String(rawUri))),
      );
      void bridge.callMain("window.registerUriHandler", id);
      return {
        dispose() {
          bridge.commandHandlers.delete(cmd);
          void bridge.callMain("window.unregisterUriHandler", id);
        },
      };
    },
    setEditorDecorations(
      decorationType: { key: string },
      ranges: readonly {
        start: { line: number; character: number };
        end: { line: number; character: number };
      }[],
    ) {
      void bridge.callMain(
        "editor.setDecorations",
        decorationType.key,
        ranges.map((r) => ({
          start: { line: r.start.line, character: r.start.character },
          end: { line: r.end.line, character: r.end.character },
        })),
      );
    },
    registerFileDecorationProvider(provider: {
      provideFileDecoration(uri: Uri): Promise<unknown> | unknown;
    }) {
      const id = `fd-${++panelCounter}`;
      const cmd = `__fileDeco.provide.${id}`;
      bridge.commandHandlers.set(cmd, (uriPath: unknown) =>
        provider.provideFileDecoration(Uri.file(String(uriPath))),
      );
      void bridge.callMain("window.registerFileDecorationProvider", id);
      return {
        dispose() {
          bridge.commandHandlers.delete(cmd);
          void bridge.callMain("window.unregisterFileDecorationProvider", id);
        },
      };
    },
    ...createMessagesApi(bridge),
    ...createQuickInputApi(bridge),

    createStatusBarItem: statusBar.createStatusBarItem,
  };
  return Object.assign(api, createExternalUriOpenerApi(bridge, api.showQuickPick));
}
