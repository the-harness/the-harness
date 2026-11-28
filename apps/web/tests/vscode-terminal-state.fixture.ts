import { createApp, effectScope, h } from "vue";
import { UiCommandsService } from "@harness/ui-commands";
import { TerminalInstance, UiTerminalService } from "@harness/ui-terminal";
import { createMainThreadTerminal } from "../../../packages/vscode-ext-host/src/main-thread/terminal.ts";
import "virtual:uno.css";
import "../src/style.css";

const scope = effectScope();
const terminal = new UiTerminalService();
const commands = scope.run(() => new UiCommandsService())!;
const main = createMainThreadTerminal(terminal, commands, (session, command, args) =>
  (
    window as typeof window & {
      executeTerminalCommand(session: string, command: string, args: unknown[]): Promise<unknown>;
    }
  ).executeTerminalCommand(session, command, args),
);
const views: (() => void)[] = [];
export function dispatch(session: string, method: string, args: unknown[]) {
  return main(session, method, args);
}
export function mount(name: string) {
  const item = terminal.terminals.find((item) => item.title === name);
  if (!item) throw new Error(`No terminal named ${name}`);
  const node = document.createElement("div");
  node.style.cssText = "width:900px;height:500px";
  document.body.append(node);
  const app = createApp({
    render: () => h(TerminalInstance, { terminalId: item.id, active: true }),
  });
  app.mount(node);
  views.push(() => {
    app.unmount();
    node.remove();
  });
}
export function unmount() {
  for (const dispose of views.splice(0)) dispose();
}
export async function dispose() {
  unmount();
  await main.reset();
  scope.stop();
}
