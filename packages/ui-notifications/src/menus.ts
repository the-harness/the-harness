import { Menu, MenuAction } from "@harness/ui-menu";
import type { UiNotificationService } from "./index.ts";

export interface NotificationMenuContext {
  readonly id?: number;
  readonly message: string;
}

export function createNotificationMenu(
  notifications: Pick<UiNotificationService, "prompts" | "message" | "dismiss">,
  isDisposed: () => boolean,
) {
  return new Menu({
    actions: (context: NotificationMenuContext) => {
      const prompt = notifications.prompts.value.find((item) => item.id === context.id);
      if (isDisposed() || (context.id === undefined
        ? !context.message || notifications.message.value !== context.message
        : !prompt || prompt.modal || prompt.message !== context.message)) return [];
      return [
        new MenuAction({
          id: "copy", label: "Copy Message",
          run: () => navigator.clipboard.writeText(
            [context.message, prompt?.detail].filter(Boolean).join("\n\n"),
          ),
        }),
        new MenuAction({
          id: "dismiss", label: "Dismiss Notification",
          run: () => prompt ? prompt.finish() : notifications.dismiss(),
        }),
      ];
    },
  });
}
