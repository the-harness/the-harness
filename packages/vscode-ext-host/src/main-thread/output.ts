import type { OutputChannel, OutputChannelGroup, UiOutputService } from "@harness/ui-output";
import type { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { effectScope, type EffectScope } from "vue";

export function createMainThreadOutput(
  output: UiOutputService,
  group: OutputChannelGroup,
  isForeground: () => boolean,
  workbench: Pick<UiWorkbenchService, "open">,
  tabs: Pick<UiTabsService, "close">,
) {
  const channels = new Map<string, { channel: OutputChannel; scope: EffectScope }>();

  function handle(method: string, args: unknown[]): void {
    const [id, value] = args as [string, unknown];
    if (method === "output.create") {
      const name = typeof value === "string" ? value : id;
      if (!channels.has(id)) {
        const scope = effectScope();
        const channel = scope.run(() => output.useChannel(name, group, id))!;
        channels.set(id, { channel, scope });
      }
      return;
    }
    const entry = channels.get(id);
    if (!entry) return;
    const { channel, scope } = entry;
    if (method === "output.append") {
      channel.append(value as string);
      return;
    }
    if (method === "output.appendLine") {
      channel.appendLine(value as string);
      return;
    }
    if (method === "output.clear") {
      channel.clear();
      return;
    }
    if (method === "output.replace") {
      channel.clear();
      if (value) channel.append(value as string);
      return;
    }
    if (method === "output.show") {
      if (!isForeground()) return;
      const focused = document.activeElement;
      output.activeChannelId.value = channel.id;
      workbench.open("output");
      if (value && focused instanceof HTMLElement) focused.focus();
      return;
    }
    if (method === "output.hide") {
      if (!isForeground()) return;
      if (output.activeChannelId.value === channel.id) tabs.close("output");
      return;
    }
    if (method === "output.dispose") {
      scope.stop();
      channels.delete(id);
      return;
    }
  }

  function dispose(): void {
    for (const { scope } of channels.values()) scope.stop();
    channels.clear();
  }

  return { handle, dispose };
}
