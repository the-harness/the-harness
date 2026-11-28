import { shallowReactive } from "vue";

export interface ChatInputNotificationState {
  readonly key: string;
  readonly hostSessionId: string;
  readonly id: string;
  readonly severity: number;
  readonly message: string;
  readonly description?: string;
  readonly actions: readonly { label: string; commandId: string; commandArgs?: unknown[] }[];
  readonly dismissible: boolean;
  readonly autoDismissOnMessage: boolean;
  readonly sessionTypes?: readonly string[];
}

export function createMainThreadChatInputNotifications(
  execute: (sessionId: string, command: string, args: unknown[]) => Promise<unknown>,
) {
  const notifications = shallowReactive(new Map<string, ChatInputNotificationState>());
  const keyFor = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);
  return {
    notifications,
    handle(sessionId: string, method: string, args: unknown[]): boolean {
      if (method === "chatInput.setNotification") {
        const value = args[0] as Omit<ChatInputNotificationState, "key" | "hostSessionId">;
        const key = keyFor(sessionId, value.id);
        notifications.set(key, { ...value, key, hostSessionId: sessionId });
        return true;
      }
      if (method === "chatInput.removeNotification") {
        notifications.delete(keyFor(sessionId, String(args[0])));
        return true;
      }
      return false;
    },
    async invokeAction(key: string, index: number): Promise<void> {
      const value = notifications.get(key);
      if (!value?.actions[index]) return;
      await execute(value.hostSessionId, "__chatInput.invokeAction", [value.id, index]);
    },
    async dismiss(key: string, automatic = false): Promise<void> {
      const value = notifications.get(key);
      if (!value || !(automatic ? value.autoDismissOnMessage : value.dismissible)) return;
      await execute(value.hostSessionId, "__chatInput.dismiss", [
        value.id,
        automatic ? "message" : "user",
      ]);
    },
    clearSession(sessionId: string): void {
      for (const [key, value] of notifications)
        if (value.hostSessionId === sessionId) notifications.delete(key);
    },
  };
}
