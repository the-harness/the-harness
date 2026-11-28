import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createMainThreadTasks } from "../../packages/vscode-ext-host/src/main-thread/tasks.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("discovers, resolves, and disposes same-type task providers independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "vscode-task-providers-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "tasks");
  const { service: host, dispose } = await createExtensionHostFixture();
  const session = "task-provider-registrations";
  const registrations: unknown[][] = [];
  const launches: unknown[] = [];
  const main = createMainThreadTasks(
    {
      async create(options: unknown) {
        launches.push(options);
        return { id: "fixture-terminal", pid: 42 };
      },
      async kill() {},
      onDidExit() {
        return { dispose() {} };
      },
      observe(_id: string, listener: { onExit(code: number): void }) {
        queueMicrotask(() => listener.onExit(0));
        return { dispose() {} };
      },
    } as never,
    { useCommand() {} } as never,
    (command, args) => host.executeCommand(session, command, ...args),
  );
  const stop = host.onMainThreadCall(async (_id, method, args, requestId) => {
    try {
      if (method.startsWith("tasks.")) {
        if (method.endsWith("Provider")) registrations.push([method, ...args]);
        await main(method, args);
      }
      host.resolveMainCall(requestId);
    } catch (error) {
      host.resolveMainCall(requestId, undefined, error as Error);
    }
  });
  const run = (command: string, ...args: unknown[]) =>
    host.executeCommand(session, command, ...args);

  try {
    await mkdir(extension, { recursive: true });
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        name: "tasks",
        publisher: "fixture",
        version: "1.0.0",
        main: "./index.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, "index.cjs"),
      String.raw`
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  const type = "shared-task";
  const make = name => new v.Task({ type }, v.TaskScope.Workspace, name, "fixture");
  const calls = [];
  const registrations = new Map();
  const pending = {};
  const providers = {
    first: {
      provideTasks: () => [make("first")],
      resolveTask() {
        calls.push("first");
        throw new Error("Fixture resolver declined");
      },
    },
    second: {
      provideTasks: async () => [make("second")],
      resolveTask(task) {
        calls.push("second");
        task.execution = new v.ProcessExecution(process.execPath, ["-e", ""]);
        return task;
      },
    },
    failing: { provideTasks: () => Promise.reject(new Error("Fixture discovery failed")) },
    empty: { provideTasks: () => null },
    disposed: { provideTasks: wait("disposed") },
    timedOut: { provideTasks: wait("timedOut") },
  };
  function wait(name) {
    return token => new Promise(resolve => {
      pending[name] = "waiting";
      token.onCancellationRequested(() => {
        pending[name] = "cancelled";
        if (name === "disposed") resolve([make("late result")]);
      });
    });
  }
  subscriptions.push(
    v.commands.registerCommand("test.add", name => {
      const registration = v.tasks.registerTaskProvider(type, providers[name]);
      registrations.set(name, registration);
      subscriptions.push(registration);
    }),
    v.commands.registerCommand("test.drop", name => registrations.get(name).dispose()),
    v.commands.registerCommand("test.fetch", async () =>
      (await v.tasks.fetchTasks({ type })).map(task => task.name)
    ),
    v.commands.registerCommand("test.pending", name => pending[name]),
    v.commands.registerCommand("test.execute", async () => {
      const task = make("resolve-me");
      const end = new Promise(resolve => {
        const listener = v.tasks.onDidEndTaskProcess(event => {
          if (event.execution.task === task) {
            listener.dispose();
            resolve(event.exitCode);
          }
        });
      });
      const execution = await v.tasks.executeTask(task);
      return { same: execution.task === task, calls, exit: await end };
    }),
  );
};
`,
    );
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");

    for (const provider of ["first", "second", "failing", "empty"]) {
      await run("test.add", provider);
    }
    expect(await run("test.fetch")).toEqual(["first", "second"]);
    expect(await run("test.execute")).toEqual({ same: true, calls: ["first", "second"], exit: 0 });
    expect(launches).toEqual([expect.objectContaining({ args: ["-e", ""] })]);

    await run("test.drop", "failing");
    await run("test.drop", "empty");
    await run("test.add", "disposed");
    const fetching = run("test.fetch");
    await expect.poll(() => run("test.pending", "disposed")).toBe("waiting");
    await run("test.drop", "disposed");
    expect(await fetching).toEqual(["first", "second"]);
    expect(await run("test.pending", "disposed")).toBe("cancelled");

    await run("test.add", "timedOut");
    expect(await run("test.fetch")).toEqual(["first", "second"]);
    expect(await run("test.pending", "timedOut")).toBe("cancelled");
    await run("test.drop", "timedOut");
    await run("test.drop", "first");
    expect(await run("test.fetch")).toEqual(["second"]);
    await run("test.drop", "second");
    expect(await run("test.fetch")).toEqual([]);

    expect(registrations).toEqual([
      ["tasks.registerProvider", "shared-task"],
      ["tasks.unregisterProvider", "shared-task"],
    ]);
  } finally {
    stop();
    await main.reset();
    main.dispose();
    await dispose(session);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
