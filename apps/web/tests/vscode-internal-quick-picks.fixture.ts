import { createRootScope } from "@harness/di";
import { UiCommandsService } from "@harness/ui-commands";
import { provideScope } from "@harness/ui-di";
import { QuickInputModal, UiQuickInputService } from "@harness/ui-quick-input";
import type { UiTerminalService } from "@harness/ui-terminal";
import { createApp, h, shallowRef } from "vue";
import { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import { createMainThreadTasks } from "../../../packages/vscode-ext-host/src/main-thread/tasks.ts";

let client: { handleMainCall(id: string, method: string, args: unknown[]): Promise<unknown> };
const tasks: { title?: string; args?: string[] }[] = [];
const browserLinks: string[] = [];
const scope = createRootScope();
scope.provideAll([UiCommandsService, UiQuickInputService]);
const commands = scope.get(UiCommandsService);

export function openQuickPickConsumers(
  execute: (command: string, args: unknown[]) => Promise<unknown>,
) {
  const terminal = {
    async create({ title, args }: { title?: string; args?: string[] }) {
      tasks.push({ title, args });
      return { id: `task-terminal-${tasks.length}`, pid: 100 + tasks.length };
    },
    onDidExit: () => ({ dispose() {} }),
    observe: () => ({ dispose() {} }),
  } as unknown as UiTerminalService;
  client = Object.assign(Object.create(WorkspaceExtensionHostClient.prototype), {
    foregroundState: shallowRef(true),
    fileDecorations: { handle: () => false },
    handleTerminal: () => false,
    handleTasks: createMainThreadTasks(terminal, commands, execute),
    quickInput: scope.get(UiQuickInputService),
    envCompat: {
      openExternal(target: string) {
        browserLinks.push(target);
        return true;
      },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  createApp({
    setup() {
      provideScope(scope);
      return () => h(QuickInputModal);
    },
  }).mount(container);
}

export function dispatchQuickPickConsumer(id: string, method: string, args: unknown[]) {
  return client.handleMainCall(id, method, args);
}

export function runTaskProvider() {
  return commands.execute("workbench.action.tasks.runTask:fixture");
}

export function pickedActions() {
  return { tasks, browserLinks };
}
