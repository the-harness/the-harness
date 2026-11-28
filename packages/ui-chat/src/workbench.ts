import { inject } from "@harness/di";
import { UiWorkbenchService } from "@harness/ui-workbench";
import ChatPanel from "./panels/ChatPanel.vue";

export function useChatWorkbench(): void {
  const workbench = inject(UiWorkbenchService);
  workbench.use({
    id: "harness.chat",
    panels: [
      {
        id: "chat",
        title: "Chat",
        icon: "i-codicon-chat-sparkle",
        component: ChatPanel,
        location: "within",
      },
    ],
  });
}
