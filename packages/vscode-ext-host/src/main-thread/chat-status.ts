import { shallowReactive } from "vue";

export interface ChatStatusItemState {
  readonly key: string;
  readonly hostSessionId: string;
  readonly id: string;
  readonly title: string | { label: string; link: string; helpText?: string };
  readonly description: string;
  readonly detail?: string;
  readonly tooltip?: string;
}

export function createMainThreadChatStatus() {
  const items = shallowReactive(new Map<string, ChatStatusItemState>());
  const keyFor = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);
  return {
    items,
    handle(sessionId: string, method: string, args: unknown[]): boolean {
      if (method === "chatStatus.setItem") {
        const item = args[0] as Omit<ChatStatusItemState, "key" | "hostSessionId">;
        const key = keyFor(sessionId, item.id);
        items.set(key, { ...item, key, hostSessionId: sessionId });
        return true;
      }
      if (method === "chatStatus.removeItem") {
        items.delete(keyFor(sessionId, String(args[0])));
        return true;
      }
      return false;
    },
    clearSession(sessionId: string): void {
      for (const [key, item] of items) if (item.hostSessionId === sessionId) items.delete(key);
    },
  };
}
