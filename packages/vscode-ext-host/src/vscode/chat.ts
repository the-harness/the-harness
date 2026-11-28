import type { ExtHostBridge } from "./bridge.ts";
import type { createWebviewApi } from "./webviews.ts";
import {
  CancellationTokenSource,
  Disposable,
  type CancellationToken,
  type MarkdownString,
  type Uri,
} from "./types.ts";

type Panel = ReturnType<ReturnType<typeof createWebviewApi>["createWebviewPanel"]>;
export interface ChatOutputRenderer {
  // Extensions render a contributed MIME type into the supplied webview.
  renderChatOutput(
    data: { mime: string; value: Uint8Array },
    view: Pick<Panel, "webview" | "onDidDispose">,
    context: unknown,
    token: CancellationToken,
  ): PromiseLike<void>;
}

export interface ChatResponseStream {
  push(part: unknown): ChatResponseStream;
  markdown(value: string | MarkdownString): ChatResponseStream;
  markdownWithVulnerabilities(
    value: string | MarkdownString,
    vulnerabilities: unknown[],
  ): ChatResponseStream;
  warning(value: string | MarkdownString): ChatResponseStream;
  info(value: string | MarkdownString): ChatResponseStream;
  anchor(value: unknown, title?: string): ChatResponseStream;
  button(command: { title: string; command: string; arguments?: unknown[] }): ChatResponseStream;
  filetree(value: { name: string; children?: unknown[] }[], baseUri: Uri): ChatResponseStream;
  progress(value: string, task?: unknown): ChatResponseStream;
  reference(value: unknown, iconPath?: unknown): ChatResponseStream;
  reference2(value: unknown, iconPath?: unknown, options?: unknown): ChatResponseStream;
  thinkingProgress(delta: {
    text?: string | string[];
    id?: string;
    metadata?: Record<string, unknown>;
  }): ChatResponseStream;
}

type ChatHandler = (
  request: Record<string, any>,
  context: { history: unknown[] },
  stream: ChatResponseStream,
  token: CancellationToken,
) => unknown;

function json(value: unknown): any {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emptyEvent<T>(
  _listener: (event: T) => unknown,
  _thisArgs?: unknown,
  disposables?: Disposable[],
): Disposable {
  const subscription = Disposable.from();
  disposables?.push(subscription);
  return subscription;
}

export function createChatNamespace(
  bridge: ExtHostBridge,
  window: Pick<ReturnType<typeof createWebviewApi>, "createWebviewPanel">,
) {
  const disposables = new Set<() => void>();
  const pendingNotifications = new Set<Promise<unknown>>();
  const inputNotifications = new Map<string, unknown>();
  const notificationsById = new Map<string, { item: Record<string, any>; visible(): boolean }>();
  let nextNotification = 0;
  bridge.commandHandlers.set("__chatInput.invokeAction", async (rawId, rawIndex) => {
    const notification = notificationsById.get(String(rawId));
    if (!notification || !notification.visible())
      throw new Error("Chat input notification is no longer visible");
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0)
      throw new TypeError("Invalid chat notification action");
    const action = notification.item.actions[index] as
      | { commandId: string; commandArgs?: unknown[] }
      | undefined;
    if (!action) throw new Error("Chat notification action is no longer available");
    if (!bridge.commandHandlers.has(action.commandId))
      await bridge.activateByEvent?.(`onCommand:${action.commandId}`);
    const handler = bridge.commandHandlers.get(action.commandId);
    return handler
      ? await handler(...(action.commandArgs ?? []))
      : await bridge.callMain("commands.execute", action.commandId, ...(action.commandArgs ?? []));
  });
  bridge.commandHandlers.set("__chatInput.dismiss", (rawId, reason) => {
    const notification = notificationsById.get(String(rawId));
    if (!notification || !notification.visible()) return false;
    if (
      reason === "message"
        ? !notification.item.autoDismissOnMessage
        : !notification.item.dismissible
    )
      return false;
    notification.item.hide();
    return true;
  });
  bridge.commandHandlers.set("__chat.dispose", async () => {
    for (const dispose of [...disposables]) dispose();
    await Promise.all(pendingNotifications);
  });
  const renderers = new Map<string, { renderer: ChatOutputRenderer; owner?: string }>();
  bridge.commandHandlers.set("__chat.renderOutput", async (viewType, rawData, context) => {
    const registration = renderers.get(String(viewType));
    if (!registration) throw new Error(`Unknown chat output renderer: ${String(viewType)}`);
    const data = rawData as { mime: string; value: number[] };
    const panel = window.createWebviewPanel(
      String(viewType),
      String(viewType),
      1,
      {},
      registration.owner,
    );
    const source = new CancellationTokenSource();
    const subscription = panel.onDidDispose(() => source.cancel());
    try {
      await registration.renderer.renderChatOutput(
        { ...data, value: Uint8Array.from(data.value) },
        panel,
        context ?? {},
        source.token,
      );
      return panel.webview.html;
    } catch (error) {
      panel.dispose();
      throw error;
    } finally {
      subscription.dispose();
      source.dispose();
    }
  });
  return {
    onDidDisposeChatSession: emptyEvent<string>,
    createInputNotification(id: string) {
      const key = `${bridge.getExtensionPath?.() ?? ""}\0${id}`;
      if (inputNotifications.has(key))
        throw new Error(`Chat input notification '${id}' already exists`);
      const state = {
        id: `chat-input-${++nextNotification}`,
        severity: 0,
        message: "",
        description: undefined as string | undefined,
        actions: [] as { label: string; commandId: string; commandArgs?: unknown[] }[],
        dismissible: true,
        autoDismissOnMessage: false,
        sessionTypes: undefined as readonly string[] | undefined,
      };
      let disposed = false,
        visible = false;
      const send = (method: string, value: unknown) => {
        const operation = bridge.callMain(method, value).catch((error) => console.error(error));
        pendingNotifications.add(operation);
        void operation.finally(() => pendingNotifications.delete(operation));
      };
      const sync = () => {
        if (disposed) throw new Error("Chat input notification is disposed");
        if (visible) send("chatInput.setNotification", json(state));
      };
      const item: Record<string, any> = {
        id,
        show() {
          visible = true;
          sync();
        },
        hide() {
          if (disposed) return;
          visible = false;
          send("chatInput.removeNotification", state.id);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          visible = false;
          send("chatInput.removeNotification", state.id);
          inputNotifications.delete(key);
          notificationsById.delete(state.id);
          disposables.delete(item.dispose);
        },
      };
      for (const name of [
        "severity",
        "message",
        "description",
        "actions",
        "dismissible",
        "autoDismissOnMessage",
        "sessionTypes",
      ] as const) {
        Object.defineProperty(item, name, {
          enumerable: true,
          get: () => state[name],
          set(value) {
            (state as Record<string, unknown>)[name] =
              name === "actions"
                ? value.map((action: any) => ({
                    label: action.label,
                    commandId: action.commandId,
                    commandArgs: action.commandArgs,
                  }))
                : value;
            sync();
          },
        });
      }
      Object.freeze(item);
      inputNotifications.set(key, item);
      notificationsById.set(state.id, { item, visible: () => visible });
      disposables.add(item.dispose);
      return item;
    },
    createChatParticipant(id: string, handler: ChatHandler): Record<string, any> {
      if (!id || typeof handler !== "function")
        throw new TypeError("A participant ID and request handler are required");
      console.warn(
        `vscode.chat.createChatParticipant(${JSON.stringify(id)}) is disabled in Harness.`,
      );
      return {
        get id() {
          return id;
        },
        requestHandler: handler,
        onDidReceiveFeedback: emptyEvent<unknown>,
        onDidPerformAction: emptyEvent<unknown>,
        dispose() {},
      };
    },
    registerChatOutputRenderer(viewType: string, renderer: ChatOutputRenderer) {
      if (renderers.has(viewType))
        throw new Error(`Chat output renderer already registered: ${viewType}`);
      renderers.set(viewType, { renderer, owner: bridge.getExtensionPath?.() });
      return new Disposable(() => {
        if (renderers.get(viewType)?.renderer === renderer) renderers.delete(viewType);
      });
    },
  };
}
