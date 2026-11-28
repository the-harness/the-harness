import { Menu, MenuAction } from "@harness/ui-menu";
import type { UiChatManagerService } from "@harness/ui-chat-manager";
import type { UserMessage } from "@harness/llm";
import type { UiChatService } from "./chat.ts";
import type { SessionMessage } from "./types.ts";
import { getPendingText } from "./transcript.ts";

export interface ChatMenuContext {
  readonly message?: SessionMessage;
  readonly input?: UserMessage;
  readonly selection: string;
  readonly link?: string;
  readonly canEdit: boolean;
  readonly canReuse: boolean;
  readonly edit: () => void;
  readonly remove: () => Promise<void>;
  readonly openLink: () => void;
  readonly reuse: () => void;
  readonly selectAll: () => void;
}

export function createChatMenu(chat: Pick<UiChatService, "messages">) {
  return new Menu({
    queue: (context: ChatMenuContext) => context.input ? [
      new MenuAction({ id: "edit", label: "Edit", disabled: !context.canEdit, run: context.edit }),
      new MenuAction({ id: "copy", label: "Copy", disabled: !getPendingText(context.input), run: () => navigator.clipboard.writeText(getPendingText(context.input!)) }),
      new MenuAction({ id: "remove", label: "Remove", run: context.remove }),
    ] : [],
    clipboard: (context: ChatMenuContext) => context.input ? [] : [
      new MenuAction({ id: "copy", label: "Copy", disabled: !context.selection, run: () => navigator.clipboard.writeText(context.selection) }),
      new MenuAction({ id: "copy-message", label: context.message ? "Copy Message" : "Copy Conversation",
        disabled: context.message ? !context.message.text : !chat.messages.value.length,
        run: () => navigator.clipboard.writeText(context.message?.text ?? chat.messages.value.map((item) => item.text).filter(Boolean).join("\n\n")) }),
    ],
    links: (context: ChatMenuContext) => context.input || !context.link ? [] : [
      new MenuAction({ id: "open-link", label: "Open Link", run: context.openLink }),
      new MenuAction({ id: "copy-link", label: "Copy Link", run: () => navigator.clipboard.writeText(context.link!) }),
    ],
    prompt: (context: ChatMenuContext) => context.input || context.message?.role !== "user" ? [] : [
      new MenuAction({ id: "reuse", label: "Reuse Prompt", disabled: !context.canReuse, run: context.reuse }),
    ],
    selection: (context: ChatMenuContext) => context.input ? [] : [
      new MenuAction({ id: "select-all", label: "Select All", run: context.selectAll }),
    ],
  });
}

export function createModelMenu(chatManager: Pick<UiChatManagerService, "models" | "model">) {
  return new Menu({
    models: () => chatManager.models.value.map((item) => new MenuAction({
      id: item.id,
      type: "radio",
      label: item.name,
      checked: chatManager.model.value === item.id,
      run: () => { chatManager.model.value = item.id; },
    })),
  });
}
