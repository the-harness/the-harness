import type { StatusBarItem } from "@harness/ui-status-bar";
import {
  Disposable,
  StatusBarAlignment,
  type Command,
  type MarkdownString,
  type ThemeColor,
} from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";

type AccessibilityInformation = { label: string; role?: string };
type Tooltip = string | MarkdownString;
type ItemCommand = string | Command;

export type StatusBarUpdate = {
  [Key in keyof Omit<StatusBarItem, "id" | "alignment" | "priority">]?: StatusBarItem[Key] | null;
};

function renderColor(color: string | ThemeColor | undefined): string | null {
  if (typeof color === "string") return color;
  return color && /^[\w.-]+$/.test(color.id)
    ? `var(--vscode-${color.id.replaceAll(".", "-")})`
    : null;
}

export function createStatusBarApi(bridge: ExtHostBridge) {
  let nextHandle = 0;

  function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): ExtensionItem;
  function createStatusBarItem(
    id: string,
    alignment?: StatusBarAlignment,
    priority?: number,
  ): ExtensionItem;
  function createStatusBarItem(
    idOrAlignment?: string | StatusBarAlignment,
    alignmentOrPriority?: number,
    explicitPriority?: number,
  ) {
    const explicitId = typeof idOrAlignment === "string" ? idOrAlignment : undefined;
    const alignment =
      (typeof idOrAlignment === "string" ? alignmentOrPriority : idOrAlignment) ===
      StatusBarAlignment.Right
        ? StatusBarAlignment.Right
        : StatusBarAlignment.Left;
    const suppliedPriority =
      typeof idOrAlignment === "string" ? explicitPriority : alignmentOrPriority;
    const priority =
      suppliedPriority === undefined || Number.isNaN(suppliedPriority)
        ? undefined
        : Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, suppliedPriority));
    const handle = `ext-status-${++nextHandle}`;
    const id = explicitId ?? bridge.getExtensionId?.() ?? handle;
    const side = alignment === StatusBarAlignment.Right ? "right" : "left";
    void bridge.callMain("statusBar.create", handle, side, priority ?? 0);

    let text = "";
    let name: string | undefined;
    let tooltip: Tooltip | undefined;
    let color: string | ThemeColor | undefined;
    let backgroundColor: ThemeColor | undefined;
    let accessibilityInformation: AccessibilityInformation | undefined;
    let command: ItemCommand | undefined;
    let commandHandle: string | undefined;
    let commandVersion = 0;
    let disposed = false;

    const update = (patch: StatusBarUpdate) => {
      if (!disposed) void bridge.callMain("statusBar.update", handle, patch);
    };
    const clearCommand = () => {
      if (!commandHandle) return;
      bridge.commandHandlers.delete(commandHandle);
      void bridge.callMain("commands.unregister", commandHandle);
      commandHandle = undefined;
    };

    return {
      get id() {
        return id;
      },
      get alignment() {
        return alignment;
      },
      get priority() {
        return priority;
      },
      get text() {
        return text;
      },
      set text(value: string) {
        text = value;
        update({ text });
      },
      get name() {
        return name;
      },
      set name(value: string | undefined) {
        name = value;
        update({ name: value ?? null });
      },
      get tooltip() {
        return tooltip;
      },
      set tooltip(value: Tooltip | undefined) {
        tooltip = value;
        update({
          tooltip: value && typeof value !== "string" ? { markdown: value.value } : (value ?? null),
        });
      },
      get color() {
        return color;
      },
      set color(value: string | ThemeColor | undefined) {
        color = value;
        update({ color: renderColor(value) });
      },
      get backgroundColor() {
        return backgroundColor;
      },
      set backgroundColor(value: ThemeColor | undefined) {
        const id = value?.id;
        const background =
          id === "statusBarItem.errorBackground"
            ? "error"
            : id === "statusBarItem.warningBackground"
              ? "warning"
              : null;
        backgroundColor = background ? value : undefined;
        update({ background });
      },
      get accessibilityInformation() {
        return accessibilityInformation;
      },
      set accessibilityInformation(value: AccessibilityInformation | undefined) {
        accessibilityInformation = value;
        update({
          accessibilityInformation: value ? { label: value.label, role: value.role } : null,
        });
      },
      get command() {
        return command;
      },
      set command(value: ItemCommand | undefined) {
        if (disposed || value === command) return;
        clearCommand();
        command = value;
        if (value) {
          commandHandle = `__statusBar.command.${handle}.${++commandVersion}`;
          const id = typeof value === "string" ? value : value.command;
          const args = typeof value === "string" ? [] : (value.arguments ?? []);
          bridge.commandHandlers.set(commandHandle, async () => {
            if (!bridge.commandHandlers.has(id)) await bridge.activateByEvent?.(`onCommand:${id}`);
            const handler = bridge.commandHandlers.get(id);
            return handler ? handler(...args) : bridge.callMain("commands.execute", id, ...args);
          });
          void bridge.callMain("commands.register", commandHandle);
        }
        update({ command: commandHandle ?? null });
      },
      show() {
        update({ visible: true });
      },
      hide() {
        update({ visible: false });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        clearCommand();
        void bridge.callMain("statusBar.dispose", handle);
      },
    } satisfies ExtensionItem;
  }

  const messages = new Set<{ text: string }>();
  const messageHandle = "status.extensionMessage";
  const refreshMessage = () => {
    const current = [...messages].at(-1);
    if (current) {
      void bridge.callMain("statusBar.update", messageHandle, {
        text: current.text,
        visible: true,
      });
    } else {
      void bridge.callMain("statusBar.dispose", messageHandle);
    }
  };

  function setStatusBarMessage(text: string, hideWhen?: number | PromiseLike<unknown>): Disposable {
    if (!messages.size) {
      void bridge.callMain("statusBar.create", messageHandle, "left", Number.MIN_VALUE);
      void bridge.callMain("statusBar.update", messageHandle, { name: "Extension Status" });
    }
    const message = { text };
    messages.add(message);
    refreshMessage();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposable = new Disposable(() => {
      clearTimeout(timer);
      messages.delete(message);
      refreshMessage();
    });
    const finish = () => disposable.dispose();
    if (typeof hideWhen === "number") timer = setTimeout(finish, hideWhen);
    else if (hideWhen) void Promise.resolve(hideWhen).then(finish, finish);
    return disposable;
  }

  return { createStatusBarItem, setStatusBarMessage };
}

interface ExtensionItem {
  readonly id: string;
  readonly alignment: StatusBarAlignment;
  readonly priority: number | undefined;
  name: string | undefined;
  text: string;
  tooltip: Tooltip | undefined;
  color: string | ThemeColor | undefined;
  backgroundColor: ThemeColor | undefined;
  command: ItemCommand | undefined;
  accessibilityInformation: AccessibilityInformation | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}
