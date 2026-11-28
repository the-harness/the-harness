import type { UiCommandsService } from "@harness/ui-commands";
import { effectScope, type EffectScope } from "vue";
import type { UiTerminalService } from "@harness/ui-terminal";

export function createMainThreadDebug(
  terminal: UiTerminalService,
  commands: Pick<UiCommandsService, "useCommand">,
  executeCommand: (sessionId: string, command: string, args: unknown[]) => Promise<unknown>,
) {
  const providers = new Map<string, EffectScope>();
  const handle = async (
    sessionId: string,
    method: string,
    args: unknown[],
  ): Promise<{ handled: boolean; value?: unknown }> => {
    if (method === "debug.registerProvider") {
      const type = String(args[0]),
        key = `${sessionId}:${type}`;
      if (!providers.has(key)) {
        const scope = effectScope();
        scope.run(() =>
          commands.useCommand(
            `workbench.action.debug.start:${type}`,
            () => executeCommand(sessionId, "__debug.startType", [type]),
            { title: `Debug: Start (${type})` },
          ),
        );
        providers.set(key, scope);
      }
      return { handled: true };
    }
    if (method === "debug.unregisterProvider") {
      const key = `${sessionId}:${String(args[0])}`;
      providers.get(key)?.stop();
      providers.delete(key);
      return { handled: true };
    }
    if (method === "debug.runInTerminal") {
      const [options] = args as [
        {
          args: string[];
          cwd?: string;
          env?: Record<string, string | null>;
          title?: string;
          kind?: string;
        },
      ];
      if (options.kind === "external")
        throw new Error("External debug terminals are not supported");
      const created = await terminal.create({
        title: options.title ?? "Debug",
        cwd: options.cwd,
        shell: options.args[0],
        args: options.args.slice(1),
        env: options.env,
      });
      if (!created) throw new Error("Debug terminal creation failed");
      return { handled: true, value: { processId: created.pid, shellProcessId: created.pid } };
    }
    if (method === "debug.start" || method === "debug.stop")
      throw new Error("Debug sessions must use the extension host debug adapter transport");
    return { handled: false };
  };
  return Object.assign(handle, {
    dispose() {
      for (const scope of providers.values()) scope.stop();
      providers.clear();
    },
  });
}
