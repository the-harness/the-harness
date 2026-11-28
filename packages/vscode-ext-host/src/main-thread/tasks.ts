import type { UiCommandsService } from "@harness/ui-commands";
import { effectScope, type EffectScope } from "vue";
import type { UiTerminalService } from "@harness/ui-terminal";

type ExecuteCommand = (command: string, args: unknown[]) => Promise<unknown>;
export function createMainThreadTasks(
  terminal: UiTerminalService,
  commands: Pick<UiCommandsService, "useCommand">,
  executeCommand?: ExecuteCommand,
) {
  const providerScopes = new Map<string, EffectScope>();
  const running = new Map<string, string>();
  const streams = new Map<string, { dispose(): void }>();
  const finish = (id: string, exitCode?: number) => {
    if (!running.delete(id)) return;
    streams.get(id)?.dispose();
    streams.delete(id);
    void executeCommand?.("__tasks.ended", [id, exitCode]);
  };
  const ended = terminal.onDidExit?.(({ id, exitCode }) => {
    const entry = [...running].find(([, terminalId]) => terminalId === id);
    if (!entry) return;
    finish(entry[0], exitCode);
  });
  const handle = async (method: string, args: unknown[]): Promise<boolean> => {
    if (method === "tasks.registerProvider") {
      const type = String(args[0]);
      if (!providerScopes.has(type)) {
        const scope = effectScope();
        scope.run(() =>
          commands.useCommand(
            `workbench.action.tasks.runTask:${type}`,
            async () => {
              if (!executeCommand) throw new Error("Task extension host is not connected");
              await executeCommand("__tasks.runType", [type]);
            },
            { title: `Tasks: Run ${type} Task` },
          ),
        );
        providerScopes.set(type, scope);
      }
      return true;
    }
    if (method === "tasks.unregisterProvider") {
      const type = String(args[0]);
      providerScopes.get(type)?.stop();
      providerScopes.delete(type);
      return true;
    }
    if (method === "tasks.execute") {
      if (!executeCommand || !terminal.onDidExit)
        throw new Error("Task lifecycle is not connected");
      const [id, task] = args as [
        string,
        {
          name: string;
          cwd?: string;
          shell: string;
          args: string[];
          env?: Record<string, string | null>;
        },
      ];
      const created = await terminal.create({
        title: task.name,
        cwd: task.cwd,
        shell: task.shell,
        args: task.args,
        env: task.env,
      });
      if (!created) throw new Error(`Could not create task terminal: ${task.name}`);
      running.set(id, created.id);
      if (!terminal.observe) throw new Error("Task terminal output is not connected");
      const starting = executeCommand("__tasks.started", [id, created.pid]);
      streams.set(
        id,
        terminal.observe(created.id, {
          onData: (data) => {
            void executeCommand("__tasks.output", [id, data]);
          },
          onExit: (code) => finish(id, code),
          onError: (error) => {
            console.error(error);
            finish(id);
          },
        }),
      );
      await starting;
      return true;
    }
    if (method === "tasks.terminate") {
      const id = String(args[0]),
        terminalId = running.get(id);
      if (terminalId) {
        await terminal.kill(terminalId);
        finish(id);
      }
      return true;
    }
    return false;
  };
  const reset = async () => {
    const terminals = [...running.values()];
    running.clear();
    for (const stream of streams.values()) stream.dispose();
    streams.clear();
    for (const scope of providerScopes.values()) scope.stop();
    providerScopes.clear();
    await Promise.all(terminals.map((id) => terminal.kill(id).catch(() => undefined)));
  };
  return Object.assign(handle, {
    reset,
    dispose() {
      ended?.dispose();
      void reset();
    },
  });
}
