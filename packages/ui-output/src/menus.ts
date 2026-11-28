import { Menu, MenuAction } from "@harness/ui-menu";
import type { OutputChannel } from "./index.ts";

export interface OutputMenuContext {
  readonly channelId: string;
  readonly selection: string;
  readonly selectAll: () => void;
}

export function createOutputMenu(getChannel: (id: string) => OutputChannel | undefined) {
  return new Menu({
    clipboard: (context: OutputMenuContext) => {
      const channel = getChannel(context.channelId);
      if (!channel) return [];
      return [
        new MenuAction({ id: "copy", label: "Copy", disabled: !context.selection, run: () => navigator.clipboard.writeText(context.selection) }),
        new MenuAction({ id: "copy-all", label: "Copy All", disabled: !channel.lines.length, run: () => navigator.clipboard.writeText(channel.lines.join("\n")) }),
        new MenuAction({ id: "select-all", label: "Select All", disabled: !channel.lines.length, run: context.selectAll }),
      ];
    },
    output: (context: OutputMenuContext) => {
      const channel = getChannel(context.channelId);
      return channel ? [
        new MenuAction({ id: "clear", label: "Clear Output", disabled: !channel.lines.length, run: () => channel.clear() }),
      ] : [];
    },
  });
}
