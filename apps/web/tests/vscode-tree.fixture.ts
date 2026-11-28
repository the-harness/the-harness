import { createExtensionTreeMenu } from "../../../packages/vscode-ext-host/src/menus.ts";
import { createApp, shallowRef } from "vue";
import { UiCommandsService } from "@harness/ui-commands";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { WorkspaceExtensionHostClient } from "../../../packages/vscode-ext-host/src/client-session.ts";
import ExtensionTreeViewsPanel from "../../../packages/vscode-ext-host/src/components/ExtensionTreeViewsPanel.vue";
import { createMainThreadTree } from "../../../packages/vscode-ext-host/src/main-thread/tree.ts";
import { runInInjectionContext } from "../../../packages/di/src/instantiation.ts";

let cleanup: (() => void) | undefined;
let handle: ((session: string, method: string, args: unknown[]) => Promise<unknown>) | undefined;
export function openTreeFixture(session: string) {
  cleanup?.();
  const container = document.createElement("div");
  container.hidden = true;
  document.body.appendChild(container);
  const invoke = (command: string, ...args: unknown[]) =>
    (
      window as unknown as {
        invokeBuiltinTreeCommand(command: string, args: unknown[]): Promise<unknown>;
      }
    ).invokeBuiltinTreeCommand(command, args);
  const tree = createMainThreadTree(() => {
    container.hidden = false;
  });
  const host = Object.assign(Object.create(WorkspaceExtensionHostClient.prototype), {
    id: session,
    tree,
    foregroundState: shallowRef(true),
    rpc: {
      executeCommand: ({ command, args }: { command: string; args: unknown[] }) =>
        invoke(command, ...args),
    },
  }) as Pick<
    WorkspaceExtensionHostClient,
    "getTreeChildren" | "setTreeCheckboxState" | "setTreeSelection"
  > & {
    handleMainCall(session: string, method: string, args: unknown[]): Promise<unknown>;
  };
  const client = {
    treeViews: tree.views,
    treeMenu: createExtensionTreeMenu(),
    getTreeChildren: host.getTreeChildren.bind(host),
    setTreeCheckboxState: host.setTreeCheckboxState.bind(host),
    setTreeSelection: host.setTreeSelection.bind(host),
  };
  const app = createApp(ExtensionTreeViewsPanel);
  runInInjectionContext(
    {
      get<T>(id: abstract new (...args: never[]) => T): T {
        if (id === ExtensionHostClientService) return client as T;
        if (id === UiCommandsService) return { execute: invoke } as T;
        throw new Error(`Unexpected tree fixture dependency: ${id.name}`);
      },
    },
    () => app.mount(container),
  );
  handle = (session, method, args) => {
    if (!method.startsWith("tree.")) throw new Error(`Unexpected tree call: ${method}`);
    return host.handleMainCall(session, method, args);
  };
  cleanup = () => {
    app.unmount();
    container.remove();
    handle = undefined;
  };
}
export async function dispatchTreeFixture(session: string, method: string, args: unknown[]) {
  if (!handle) throw new Error("Tree fixture is not open");
  return handle(session, method, args);
}
export function closeTreeFixture() {
  cleanup?.();
  cleanup = undefined;
}
