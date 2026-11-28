import type { ExtHostBridge } from "./bridge.ts";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, relative, isAbsolute, sep } from "node:path";
import { Disposable, EventEmitter, Uri } from "./types.ts";

interface WebviewOptions {
  enableScripts?: boolean;
  localResourceRoots?: readonly Uri[];
}

export function createWebviewApi(bridge: ExtHostBridge) {
  let resourceBase: string | undefined;
  bridge.commandHandlers.set("__webview.configure", (base) => {
    resourceBase = typeof base === "string" ? base : undefined;
  });
  const serializers = new Map<
    string,
    {
      serializer: {
        deserializeWebviewPanel(
          panel: ReturnType<typeof createWebviewPanel>,
          state: unknown,
        ): PromiseLike<void> | void;
      };
      owner?: string;
    }
  >();

  function createWebviewPanel(
    viewType: string,
    initialTitle: string,
    showOptions: number | { viewColumn?: number; preserveFocus?: boolean } = 1,
    panelOptions: WebviewOptions & {
      retainContextWhenHidden?: boolean;
      enableFindWidget?: boolean;
    } = {},
    owner = bridge.getExtensionPath?.(),
  ) {
    const id = randomUUID();
    const messageEmitter = new EventEmitter<unknown>();
    const disposeEmitter = new EventEmitter<void>();
    const viewStateEmitter = new EventEmitter<{
      webviewPanel: { viewType: string; active: boolean; visible: boolean; viewColumn: number };
    }>();
    let html = "";
    let disposed = false;
    let title = initialTitle;
    let options: WebviewOptions = panelOptions;
    let viewColumn = typeof showOptions === "number" ? showOptions : (showOptions.viewColumn ?? 1);
    let active = false;
    let visible = false;
    const assertAlive = () => {
      if (disposed) throw new Error("Webview is disposed");
    };
    bridge.commandHandlers.set(`__webview.message.${id}`, (message) =>
      messageEmitter.fire(message),
    );
    bridge.commandHandlers.set(`__webview.dispose.${id}`, () => panel.dispose());
    bridge.commandHandlers.set(`__webview.state.${id}`, (raw) => {
      const next = raw as { active: boolean; visible: boolean; viewColumn: number };
      if (active === next.active && visible === next.visible && viewColumn === next.viewColumn)
        return;
      ({ active, visible, viewColumn } = next);
      viewStateEmitter.fire({ webviewPanel: panel });
    });
    bridge.commandHandlers.set(`__webview.resource.${id}`, async (raw) => {
      assertAlive();
      const uri = Uri.from(raw as Parameters<typeof Uri.from>[0]);
      if (uri.scheme !== "file" || uri.authority)
        throw new Error("Only local file resources are supported");
      const file = await realpath(uri.fsPath);
      const roots =
        options.localResourceRoots ??
        [...bridge.getWorkspaceRoots(), ...(owner ? [owner] : [])].map(Uri.file);
      const allowed = await Promise.all(
        roots
          .filter((root) => root.scheme === "file")
          .map(async (root) => {
            try {
              const child = relative(await realpath(root.fsPath), file);
              return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
            } catch {
              return false;
            }
          }),
      );
      if (!allowed.some(Boolean)) throw new Error("Webview resource is outside localResourceRoots");
      const mime: Record<string, string> = {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".wasm": "application/wasm",
        ".json": "application/json",
      };
      return {
        body: (await readFile(file)).toString("base64"),
        mime: mime[extname(file).toLowerCase()] ?? "application/octet-stream",
      };
    });
    void bridge.callMain("webview.create", id, viewType, title, showOptions, panelOptions);
    const panel = {
      viewType,
      get title() {
        return title;
      },
      set title(value: string) {
        assertAlive();
        title = value;
        void bridge.callMain("webview.setTitle", id, value);
      },
      get active() {
        return active;
      },
      get visible() {
        return visible;
      },
      get viewColumn() {
        return viewColumn;
      },
      options: panelOptions,
      onDidDispose: disposeEmitter.event,
      onDidChangeViewState: viewStateEmitter.event,
      reveal(column?: number, preserveFocus?: boolean) {
        assertAlive();
        void bridge.callMain("webview.reveal", id, column, preserveFocus);
      },
      webview: {
        get html() {
          return html;
        },
        set html(value: string) {
          assertAlive();
          html = value;
          void bridge.callMain("webview.setHtml", id, value);
        },
        get options() {
          return options;
        },
        set options(value: WebviewOptions) {
          assertAlive();
          options = value;
          void bridge.callMain("webview.setOptions", id, value);
        },
        get cspSource() {
          return resourceBase ? new URL(resourceBase).origin : "'none'";
        },
        postMessage: (message: unknown) =>
          disposed
            ? Promise.resolve(false)
            : (bridge.callMain("webview.postMessage", id, message) as Promise<boolean>),
        onDidReceiveMessage: messageEmitter.event,
        asWebviewUri(uri: Uri) {
          assertAlive();
          if (uri.scheme === "http" || uri.scheme === "https") return uri;
          if (uri.scheme !== "file" || uri.authority || !resourceBase)
            throw new Error("Webview resource transport is unavailable");
          const base = Uri.parse(resourceBase);
          return base.with({
            path: `${base.path.replace(/\/$/, "")}/${id}/file${uri.path}`,
            query: uri.query,
            fragment: uri.fragment,
          });
        },
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const method of ["message", "dispose", "state", "resource"])
          bridge.commandHandlers.delete(`__webview.${method}.${id}`);
        disposeEmitter.fire();
        messageEmitter.dispose();
        disposeEmitter.dispose();
        viewStateEmitter.dispose();
        void bridge.callMain("webview.dispose", id);
      },
    };
    return panel;
  }

  return {
    createWebviewPanel,
    registerWebviewPanelSerializer(
      viewType: string,
      serializer: {
        deserializeWebviewPanel(
          panel: ReturnType<typeof createWebviewPanel>,
          state: unknown,
        ): PromiseLike<void> | void;
      },
    ) {
      if (serializers.has(viewType))
        throw new Error(`Webview serializer already registered: ${viewType}`);
      const owner = bridge.getExtensionPath?.();
      serializers.set(viewType, { serializer, owner });
      const command = `__webview.restore.${viewType}`;
      bridge.commandHandlers.set(command, async (raw) => {
        const snapshot = raw as { title: string; state: unknown };
        const panel = createWebviewPanel(viewType, snapshot.title, 1, {}, owner);
        try {
          await serializer.deserializeWebviewPanel(panel, snapshot.state);
        } catch (error) {
          panel.dispose();
          throw error;
        }
      });
      return new Disposable(() => {
        serializers.delete(viewType);
        bridge.commandHandlers.delete(command);
      });
    },
  };
}
