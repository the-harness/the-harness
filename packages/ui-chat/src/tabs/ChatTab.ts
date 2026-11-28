import type { UiChatManagerService } from "@harness/ui-chat-manager";
import type { UiSessionsService } from "@harness/ui-sessions";
import { TabDescriptor, type UiTabsService } from "@harness/ui-workbench";
import { variant } from "@harness/variants";
import { computed, watch } from "vue";

@variant("core:web:chat-tab")
export class ChatTabDescriptor extends TabDescriptor {
  declare readonly sessionId: string;
  declare readonly title?: string;

  get key(): string {
    return `chat:${this.sessionId}`;
  }

  get defaultTitle(): string {
    return this.title ?? "Chat";
  }
}

export function openChatTab(
  tabs: UiTabsService,
  rootSessions: UiSessionsService,
  chatManager: UiChatManagerService,
  session: { id: string; title?: string },
): void {
  const chatGroupId = (
    tabs as unknown as {
      dock?: { getPanel(id: string): { group?: { id: string } } | undefined };
    }
  ).dock?.getPanel("chat")?.group?.id;
  const tab = tabs.open(
    ChatTabDescriptor.create({ sessionId: session.id, title: session.title }),
    chatGroupId ? { groupId: chatGroupId } : undefined,
  );
  tabs.runOnce(tab, "chat", () => {
    chatManager.link(tab.scope, session.id);
    const scopedCurrent = computed(
      () =>
        rootSessions.sessions.value.find((item) => item.id === session.id) ??
        rootSessions.current.value,
    );
    watch(
      () => scopedCurrent.value?.title,
      (title) => {
        if (title) tab.title = title;
      },
      { immediate: true },
    );
  });
}
