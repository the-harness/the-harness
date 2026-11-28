import type { ExtHostBridge } from "./bridge.ts";

interface MessageItem {
  title: string;
  isCloseAffordance?: boolean;
}

interface MessageOptions {
  modal?: boolean;
  detail?: string;
}

export type ShowMessageArgs = [
  severity: "info" | "warn" | "error",
  message: string,
  items: readonly (string | MessageItem)[],
  options?: MessageOptions,
];

function createShowMessage(bridge: ExtHostBridge, severity: ShowMessageArgs[0]) {
  function showMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  function showMessage<T extends string>(
    message: string,
    options: MessageOptions,
    ...items: T[]
  ): Promise<T | undefined>;
  function showMessage<T extends MessageItem>(
    message: string,
    ...items: T[]
  ): Promise<T | undefined>;
  function showMessage<T extends MessageItem>(
    message: string,
    options: MessageOptions,
    ...items: T[]
  ): Promise<T | undefined>;
  async function showMessage<T extends string | MessageItem>(
    message: string,
    ...args: [MessageOptions, ...T[]] | T[]
  ): Promise<T | undefined> {
    const first = args[0];
    const hasFirstItem = typeof first === "string" || (first && "title" in first);
    const options = (hasFirstItem ? undefined : first) as MessageOptions | undefined;
    const items = (hasFirstItem ? args : args.slice(1)) as T[];
    const buttons = items.map((item) =>
      typeof item === "string"
        ? item
        : { title: item.title, isCloseAffordance: item.isCloseAffordance },
    );
    const wire: ShowMessageArgs = [severity, message, buttons];
    if (options) wire.push({ modal: options.modal, detail: options.detail });
    const selected = await bridge.callMain("window.showMessage", ...wire);
    return typeof selected === "number" ? items[selected] : undefined;
  }

  return showMessage;
}

export function createMessagesApi(bridge: ExtHostBridge) {
  return {
    showInformationMessage: createShowMessage(bridge, "info"),
    showWarningMessage: createShowMessage(bridge, "warn"),
    showErrorMessage: createShowMessage(bridge, "error"),
  };
}
