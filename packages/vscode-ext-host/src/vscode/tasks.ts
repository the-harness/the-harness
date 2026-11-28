import type { ExtHostBridge } from "./bridge.ts";
import type { ShowQuickPick } from "./quick-input.ts";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  ProcessExecution,
  ShellExecution,
  Task,
  type CancellationToken,
  type ShellQuotedString,
} from "@harness/vscode-types";
import { createTaskProblems, type TaskDiagnosticService } from "./task-problems.ts";
export { ShellExecution, Task } from "@harness/vscode-types";

type TaskExecution = { task: Task; terminate(): void };
type ProviderResult<T> = T | undefined | null | PromiseLike<T | undefined | null>;
type TaskProvider = {
  provideTasks(token: CancellationToken): ProviderResult<Task[]>;
  resolveTask?(task: Task, token: CancellationToken): ProviderResult<Task>;
};
type TaskProviderRegistration = { provider: TaskProvider; signal: AbortSignal };
const TASK_DISCOVERY_TIMEOUT_MS = 5_000;
let taskId = 0;

async function callTaskProvider<T>(
  registration: TaskProviderRegistration,
  call: (provider: TaskProvider, token: CancellationToken) => ProviderResult<T>,
  deadline?: AbortSignal,
): Promise<T | undefined> {
  const signal = deadline ? AbortSignal.any([registration.signal, deadline]) : registration.signal;
  if (signal.aborted) return undefined;

  const cancellation = new CancellationTokenSource();
  const stopped = Promise.withResolvers<undefined>();
  const cancel = () => {
    stopped.resolve(undefined);
    cancellation.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await Promise.race([
      call(registration.provider, cancellation.token),
      stopped.promise,
    ]);
    return result ?? undefined;
  } catch (error) {
    console.error(error);
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancellation.dispose();
  }
}

function quote(value: string | ShellQuotedString): string {
  const text = typeof value === "string" ? value : value.value;
  if (typeof value !== "string" && value.quoting === 1)
    return text.replace(/([\s\\'"$`;&|<>()])/g, "\\$1");
  if (typeof value !== "string" && value.quoting === 3)
    return '"' + text.replace(/[\\"$`]/g, "\\$&") + '"';
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

export function createTasksNamespace(
  bridge: ExtHostBridge,
  showQuickPick: ShowQuickPick,
  languages?: TaskDiagnosticService,
) {
  const problems = createTaskProblems(bridge, languages);
  const problemStreams = new Map<string, ReturnType<typeof problems.create>>();
  const started = new EventEmitter<{ execution: TaskExecution }>();
  const ended = new EventEmitter<{ execution: TaskExecution }>();
  const processStarted = new EventEmitter<{ execution: TaskExecution; processId: number }>();
  const processEnded = new EventEmitter<{ execution: TaskExecution; exitCode?: number }>();
  const executions = new Map<string, TaskExecution>();
  const providers = new Map<string, Set<TaskProviderRegistration>>();
  const types = new Set<string>();
  bridge.commandHandlers.set("__tasks.syncTypes", (value) => {
    for (const type of value as string[]) types.add(type);
  });
  bridge.commandHandlers.set("__tasks.started", (rawId, rawPid) => {
    const execution = executions.get(String(rawId));
    if (!execution) return;
    started.fire({ execution });
    processStarted.fire({ execution, processId: Number(rawPid) });
  });
  bridge.commandHandlers.set("__tasks.ended", (rawId, rawCode) => {
    const id = String(rawId),
      execution = executions.get(id);
    if (!execution) return;
    problemStreams.get(id)?.finish();
    problemStreams.delete(id);
    processEnded.fire({ execution, exitCode: typeof rawCode === "number" ? rawCode : undefined });
    executions.delete(id);
    ended.fire({ execution });
  });
  bridge.commandHandlers.set("__tasks.output", (id, value) => {
    problemStreams.get(String(id))?.write(String(value));
  });
  async function fetchTasks(filter?: { type?: string }): Promise<Task[]> {
    const requested = filter?.type ? [filter.type] : [...new Set([...types, ...providers.keys()])];
    for (const type of requested) await bridge.activateByEvent?.(`onTaskType:${type}`);
    const matching = [...providers]
      .filter(([type]) => !filter?.type || filter.type === type)
      .flatMap(([, registrations]) => [...registrations]);
    const deadline = AbortSignal.timeout(TASK_DISCOVERY_TIMEOUT_MS);
    const results = await Promise.all(
      matching.map(async (registration) => ({
        registration,
        tasks: await callTaskProvider(
          registration,
          (provider, token) => provider.provideTasks(token),
          deadline,
        ),
      })),
    );
    return results.flatMap(({ registration, tasks }) =>
      registration.signal.aborted ? [] : (tasks ?? []),
    );
  }

  async function resolveTask(task: Task): Promise<Task> {
    const type = task.definition.type;
    await bridge.activateByEvent?.(`onTaskType:${type}`);
    for (const registration of [...(providers.get(type) ?? [])]) {
      const resolved = await callTaskProvider(registration, (provider, token) =>
        provider.resolveTask?.(task, token),
      );
      if (resolved?.execution && !registration.signal.aborted) return resolved;
    }
    return task;
  }

  async function executeTask(task: Task): Promise<TaskExecution> {
    if (!task.execution) task = await resolveTask(task);
    if (
      !(task.execution instanceof ShellExecution) &&
      !(task.execution instanceof ProcessExecution)
    )
      throw new Error(`Unsupported task execution: ${task.name}`);
    const id = `task-${++taskId}`;
    const execution = {
      task,
      terminate() {
        void bridge.callMain("tasks.terminate", id);
      },
    };
    const value = task.execution,
      cwd =
        value.options.cwd ??
        (typeof task.scope === "object" ? task.scope.uri.fsPath : bridge.getWorkspaceRoots()[0]);
    let shell: string, args: string[];
    if (value instanceof ProcessExecution) {
      shell = value.process;
      args = value.args;
    } else {
      if (process.platform === "win32") throw new Error("Shell tasks on Windows are not supported");
      shell = value.options.executable ?? process.env.SHELL ?? "/bin/sh";
      const command = value.commandLine ?? [value.command!, ...value.args].map(quote).join(" ");
      args = [...(value.options.shellArgs ?? []), "-c", command];
    }
    try {
      if (task.problemMatchers.length)
        problemStreams.set(id, problems.create(task.problemMatchers, cwd ?? process.cwd()));
      executions.set(id, execution);
      await bridge.callMain("tasks.execute", id, {
        name: task.name,
        cwd,
        shell,
        args,
        env: bridge.getTerminalEnvironment?.(value.options.env, cwd) ?? value.options.env,
      });
      return execution;
    } catch (error) {
      executions.delete(id);
      problemStreams.delete(id);
      throw error;
    }
  }
  bridge.commandHandlers.set("__tasks.runType", async (rawType) => {
    const tasks = await fetchTasks({ type: String(rawType) });
    if (!tasks.length) return;
    const selected =
      tasks.length === 1
        ? tasks[0]
        : (
            await showQuickPick(
              tasks.map((task) => ({ label: task.name, description: task.source, task })),
              { placeHolder: "Select a task to run", matchOnDescription: true },
            )
          )?.task;
    if (selected) await executeTask(selected);
  });
  return {
    get taskExecutions() {
      return [...executions.values()];
    },
    onDidStartTask: started.event,
    onDidEndTask: ended.event,
    onDidStartTaskProcess: processStarted.event,
    onDidEndTaskProcess: processEnded.event,
    fetchTasks,
    executeTask,
    registerTaskProvider(type: string, provider: TaskProvider) {
      const registrations = providers.get(type) ?? new Set<TaskProviderRegistration>();
      const controller = new AbortController();
      const registration = { provider, signal: controller.signal };
      registrations.add(registration);
      if (!providers.has(type)) {
        providers.set(type, registrations);
        bridge.commandHandlers.set(`__tasks.provide.${type}`, () => fetchTasks({ type }));
        void bridge.callMain("tasks.registerProvider", type).catch(console.error);
      }
      return new Disposable(() => {
        registrations.delete(registration);
        if (registrations.size === 0) {
          providers.delete(type);
          bridge.commandHandlers.delete(`__tasks.provide.${type}`);
          void bridge.callMain("tasks.unregisterProvider", type).catch(console.error);
        }
        controller.abort();
      });
    },
  };
}
