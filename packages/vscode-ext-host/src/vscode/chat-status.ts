import type { ExtHostBridge } from "./bridge.ts";

export interface ChatStatusItemState {
  readonly id: string;
  title: string | { label: string; link: string; helpText?: string };
  description: string;
  detail: string | undefined;
  tooltip: string | undefined;
}

export function createChatStatusApi(bridge: ExtHostBridge) {
  const items = new Map<string, { dispose(): void }>();
  const pending = new Set<Promise<unknown>>();
  let sequence = 0;
  const send = (method: string, value: unknown) => {
    const operation = bridge.callMain(method, value).catch((error) => console.error(error));
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  bridge.commandHandlers.set("__chatStatus.dispose", async () => {
    for (const item of [...items.values()]) item.dispose();
    await Promise.all(pending);
  });
  return {
    createChatStatusItem(id: string) {
      const key = `${bridge.getExtensionPath?.() ?? ""}\0${id}`;
      if (items.has(key)) throw new Error(`Chat status item '${id}' already exists`);
      const state: ChatStatusItemState = {
        id: `chat-status-${++sequence}`,
        title: "",
        description: "",
        detail: "",
        tooltip: undefined,
      };
      let visible = false,
        disposed = false;
      const sync = () => {
        if (disposed) throw new Error("Chat status item is disposed");
        if (visible) send("chatStatus.setItem", JSON.parse(JSON.stringify(state)));
      };
      const item = Object.freeze({
        id,
        get title() {
          return state.title;
        },
        set title(value: ChatStatusItemState["title"]) {
          state.title = value;
          sync();
        },
        get description() {
          return state.description;
        },
        set description(value: string) {
          state.description = value;
          sync();
        },
        get detail() {
          return state.detail;
        },
        set detail(value: string | undefined) {
          state.detail = value;
          sync();
        },
        get tooltip() {
          return state.tooltip;
        },
        set tooltip(value: string | undefined) {
          state.tooltip = value;
          sync();
        },
        show() {
          visible = true;
          sync();
        },
        hide() {
          visible = false;
          send("chatStatus.removeItem", state.id);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          visible = false;
          items.delete(key);
          send("chatStatus.removeItem", state.id);
        },
      });
      items.set(key, item);
      return item;
    },
  };
}
