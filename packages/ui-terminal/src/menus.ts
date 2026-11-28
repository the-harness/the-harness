import { Menu, MenuAction } from "@harness/ui-menu";
import type { TerminalTab, UiTerminalService } from "./index.ts";

export interface TerminalMenuContext {
  readonly terminal?: TerminalTab;
  readonly area: "content" | "tab" | "panel";
  readonly selection: string;
  readonly instance?: {
    paste(text: string): void;
    selectAll(): void;
    openSearch(): void;
    clear(): void;
  };
  readonly showTabs: boolean;
  readonly create: () => Promise<void>;
  readonly focus: () => void;
  readonly kill: () => Promise<void>;
  readonly toggleTabs: () => void;
}

export function createTerminalMenu(terminal: Pick<UiTerminalService, "terminals">) {
  return new Menu({
    navigation: (context: TerminalMenuContext) => [
      new MenuAction({ id: "new", label: "New Terminal", run: context.create }),
      new MenuAction({ id: "select", label: "Focus Terminal", visible: !!context.terminal && context.area === "tab", run: context.focus }),
    ],
    clipboard: (context: TerminalMenuContext) => context.terminal && context.area !== "tab" ? [
      new MenuAction({ id: "copy", label: "Copy", disabled: !context.selection, run: () => navigator.clipboard.writeText(context.selection) }),
      new MenuAction({ id: "paste", label: "Paste", disabled: context.terminal.exited || !context.instance, run: async () => {
        const text = await navigator.clipboard.readText();
        if (terminal.terminals.includes(context.terminal!) && !context.terminal!.exited) context.instance?.paste(text);
      } }),
      new MenuAction({ id: "select-all", label: "Select All", disabled: !context.instance, run: () => context.instance?.selectAll() }),
      new MenuAction({ id: "find", label: "Find…", disabled: !context.instance, run: () => context.instance?.openSearch() }),
    ] : [],
    buffer: (context: TerminalMenuContext) => context.terminal && context.area !== "tab" ? [
      new MenuAction({ id: "clear-buffer", label: "Clear", disabled: !context.instance, run: () => context.instance?.clear() }),
    ] : [],
    terminate: (context: TerminalMenuContext) => context.terminal ? [
      new MenuAction({ id: "kill-terminal", label: "Kill Terminal", run: context.kill }),
    ] : [],
    view: (context: TerminalMenuContext) => [
      new MenuAction({ id: "show-tabs", label: "Show Terminal Tabs", type: "checkbox", checked: context.showTabs, run: context.toggleTabs }),
    ],
  });
}
