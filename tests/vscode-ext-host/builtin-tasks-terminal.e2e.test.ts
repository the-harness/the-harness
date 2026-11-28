import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { createMainThreadWorkspace } from "../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { createMainThreadTasks } from "../../packages/vscode-ext-host/src/main-thread/tasks.ts";
import { createMainThreadTerminal } from "../../packages/vscode-ext-host/src/main-thread/terminal.ts";
import { createMainThreadTree } from "../../packages/vscode-ext-host/src/main-thread/tree.ts";
import { TerminalService, type CreateTerminalOptions } from "../../packages/terminal/src/index.ts";
import { EventEmitter } from "../../packages/vscode-types/src/index.ts";

const builtins =
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
const tools = join(process.cwd(), "temp/artifacts/builtin-task-tools/node_modules");
const available =
  existsSync(join(builtins, "npm/package.json")) && existsSync(join(tools, ".bin/gulp"));
const probe = String.raw`
const v = require("vscode");
exports.activate = context => {
  const cached = new Map();
  context.subscriptions.push(v.commands.registerCommand("task.detect", async type => {
    await v.extensions.getExtension("vscode." + type).activate();
    const tasks = await v.tasks.fetchTasks({ type }); cached.set(type, tasks);
    return tasks.map(task => ({ name: task.name, definition: task.definition, execution: task.execution, group: task.group }));
  }));
  context.subscriptions.push(v.commands.registerCommand("task.run", async type => {
    const task = cached.get(type).find(task => task.definition.task === "fixture" || task.definition.script === "fixture");
    if (!task) throw new Error("Official task provider did not detect fixture task: " + type);
    const events = [];
    const done = new Promise(resolve => {
      const listeners = [v.tasks.onDidStartTask(event => { if (event.execution.task === task) events.push("start"); }), v.tasks.onDidStartTaskProcess(event => { if (event.execution.task === task) events.push(["process", event.processId > 0]); }), v.tasks.onDidEndTaskProcess(event => { if (event.execution.task === task) events.push(["exit", event.exitCode]); }), v.tasks.onDidEndTask(event => { if (event.execution.task === task) { events.push("end"); listeners.forEach(item => item.dispose()); resolve(events); } })];
    });
    await v.tasks.executeTask(task); return await done;
  }));
  context.subscriptions.push(v.commands.registerCommand("suggest.activate", async () => {
    const extension = v.extensions.getExtension("vscode.terminal-suggest"); await extension.activate(); return extension.isActive;
  }));
  context.subscriptions.push(v.commands.registerCommand("task.problem", async (matcher, text) => {
    const task = new v.Task({ type: "fixture" }, v.workspace.workspaceFolders[0], "compiler", "fixture", new v.ProcessExecution(process.execPath, ["-e", "process.stdout.write(" + JSON.stringify(text) + ");process.exitCode=1"]), [matcher]);
    const done = new Promise(resolve => {
      let exitCode;
      const processListener = v.tasks.onDidEndTaskProcess(event => { if (event.execution.task === task) exitCode = event.exitCode; });
      const end = v.tasks.onDidEndTask(event => { if (event.execution.task === task) { processListener.dispose(); end.dispose(); resolve({ exitCode, active: v.tasks.taskExecutions.length }); } });
    });
    await v.tasks.executeTask(task); return await done;
  }));
  context.subscriptions.push(v.commands.registerCommand("task.terminate", async () => {
    const task = new v.Task({ type: "fixture" }, v.workspace.workspaceFolders[0], "long running", "fixture", new v.ProcessExecution(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    const done = new Promise(resolve => {
      const start = v.tasks.onDidStartTaskProcess(event => { if (event.execution.task === task) event.execution.terminate(); });
      const end = v.tasks.onDidEndTask(event => { if (event.execution.task === task) { start.dispose(); end.dispose(); resolve(v.tasks.taskExecutions.length); } });
    });
    await v.tasks.executeTask(task); return await done;
  }));
};
`;

async function fixture(additionalBuiltins: string[] = []) {
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-tasks-"));
  const project = join(root, "project");
  mkdirSync(project);
  symlinkSync(tools, join(project, "node_modules"), "dir");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "builtin-task-fixture",
      version: "1.0.0",
      scripts: { fixture: "node -e \"console.log('TASK_NPM_OK')\"" },
    }),
  );
  writeFileSync(
    join(project, "Gruntfile.js"),
    'module.exports = grunt => grunt.registerTask("fixture", "Fixture smoke", () => grunt.log.writeln("TASK_GRUNT_OK"));',
  );
  writeFileSync(
    join(project, "gulpfile.js"),
    'exports.fixture = done => { console.log("TASK_GULP_OK"); done(); };',
  );
  writeFileSync(
    join(project, "Jakefile.js"),
    'desc("Fixture smoke"); task("fixture", () => console.log("TASK_JAKE_OK"));',
  );
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const name of ["npm", "grunt", "gulp", "jake", "terminal-suggest", ...additionalBuiltins])
    cpSync(join(builtins, name), join(extensions, name), { recursive: true });
  const extension = join(extensions, "probe");
  mkdirSync(extension);
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "harness",
      name: "task-probe",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: [
        "onCommand:task.detect",
        "onCommand:task.run",
        "onCommand:suggest.activate",
        "onCommand:task.problem",
        "onCommand:task.terminate",
      ],
    }),
  );
  writeFileSync(join(extension, "extension.cjs"), probe);
  const modules = await createHarnessModules();
  const [di, storage, configModule, workspaceModule] = await Promise.all([
    modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
    modules.load<typeof import("../../packages/ui-storage/src/storage.ts")>(
      "/packages/ui-storage/src/storage.ts",
    ),
    modules.load<typeof import("../../packages/ui-config/src/index.ts")>(
      "/packages/ui-config/src/index.ts",
    ),
    modules.load<typeof import("../../packages/ui-workspace/src/node.ts")>(
      "/packages/ui-workspace/src/node.ts",
    ),
  ]);
  const scope = di.createRootScope();
  scope.provideAll([
    storage.UiStorageService,
    configModule.UiConfigService,
    workspaceModule.WorkspaceFsService,
  ]);
  const config = scope.get(configModule.UiConfigService),
    filesystem = scope.get(workspaceModule.WorkspaceFsService);
  for (const type of ["npm", "grunt", "gulp", "jake"]) config.set(`${type}.autoDetect`, "on");
  config.set("npm.packageManager", "npm");
  config.set("npm.scriptRunner", "npm");
  config.set("npm.fetchOnlinePackageInfo", false);
  const handleWorkspace = createMainThreadWorkspace(
    {
      activeRoots: { value: [project] },
      getRoot: () => ({
        readFile: (path: string) => filesystem.readFile(project, path),
        loadDir: (path: string) => filesystem.readDir(project, path, true),
      }),
    } as never,
    config,
  );
  const terminal = new TerminalService();
  const output = new Map<string, string>();
  const exited = new EventEmitter<{ id: string; exitCode: number }>();
  const terminalAdapter = {
    onDidExit: exited.event,
    async create(options: CreateTerminalOptions) {
      const created = await terminal.create(options);
      output.set(created.id, "");
      terminal.attach(created.id, {
        onData(data) {
          output.set(created.id, output.get(created.id)! + data);
        },
        onExit(exitCode) {
          exited.fire({ id: created.id, exitCode });
        },
      });
      return created;
    },
    write: (id: string, text: string) => terminal.write(id, text),
    kill: (id: string) => terminal.kill(id),
    observe(id: string, listener: { onData(data: string): void; onExit(code: number): void }) {
      const attachment = terminal.attach(id, listener);
      if (!attachment) throw new Error(`Unknown task terminal: ${id}`);
      if (attachment.snapshot.data) listener.onData(attachment.snapshot.data);
      if (attachment.snapshot.info.exited)
        queueMicrotask(() => listener.onExit(attachment.snapshot.info.exitCode ?? 0));
      return { dispose: () => attachment.detach() };
    },
  };
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const commandAdapter = {
    useCommand(name: string, callback: (...args: unknown[]) => unknown) {
      registeredCommands.set(name, callback);
    },
    has: (name: string) => registeredCommands.has(name),
    execute: (name: string, ...args: unknown[]) => registeredCommands.get(name)?.(...args),
  };
  const tree = createMainThreadTree();
  const handleTasks = createMainThreadTasks(
    terminalAdapter as never,
    commandAdapter as never,
    (command, args) => runtime.host.executeCommand("tasks", command, ...args),
  );
  const handleTerminal = createMainThreadTerminal(
    terminalAdapter as never,
    commandAdapter as never,
    (session, command, args) => runtime.host.executeCommand(session, command, ...args),
  );
  const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (method.startsWith("workspace."))
      return { handled: true, result: await handleWorkspace(method, args) };
    if (
      (await handleTasks(method, args)) ||
      (await handleTerminal(session, method, args)) ||
      tree.handle(method, args)
    )
      return { handled: true };
    return { handled: false };
  });
  await runtime.host.scanExtensions(extensions);
  await runtime.host.startSession("tasks", [project], {
    storageRoot: join(root, "storage"),
    configuration: config.snapshot(),
    environment: { language: "en" },
  });
  return {
    ...runtime,
    root,
    project,
    output,
    async dispose() {
      await runtime.dispose("tasks");
      handleTasks.dispose();
      terminal.dispose();
      exited.dispose();
      scope.dispose();
      await modules.close();
      writeFileSync(join(root, "terminal-output.json"), JSON.stringify([...output], null, 2));
    },
  };
}

describe.skipIf(!available)("official task and terminal builtins", () => {
  it.each(["npm", "grunt", "gulp", "jake"])(
    "detects and executes an official %s task in a real project",
    { timeout: 60_000 },
    async (type) => {
      const runtime = await fixture();
      try {
        const tasks = await runtime.host.executeCommand<
          {
            definition: { task?: string; script?: string };
            execution: { args?: unknown[]; options?: { cwd?: string } };
          }[]
        >("tasks", "task.detect", type);
        writeFileSync(join(runtime.root, `${type}-tasks.json`), JSON.stringify(tasks, null, 2));
        const task = tasks.find(
          (task) => task.definition.task === "fixture" || task.definition.script === "fixture",
        );
        expect(task?.execution.options?.cwd).toBe(runtime.project);
        expect(JSON.stringify(task?.execution)).toContain("fixture");
        const events = await runtime.host.executeCommand("tasks", "task.run", type);
        expect(events).toEqual(["start", ["process", true], ["exit", 0], "end"]);
        expect([...runtime.output.values()].join("")).toContain(`TASK_${type.toUpperCase()}_OK`);
        expect(runtime.errors).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );
  it("returns actual official terminal-suggest completions", { timeout: 60_000 }, async () => {
    const runtime = await fixture();
    try {
      expect(await runtime.host.executeCommand("tasks", "suggest.activate")).toBe(true);
      const result = await runtime.host.executeCommand("tasks", "__term.provideCompletions", {
        terminal: {
          name: "fixture",
          state: { shell: "bash" },
          shellIntegration: {
            cwd: { scheme: "file", path: runtime.project },
            env: { value: { PATH: process.env.PATH, HOME: runtime.root } },
          },
        },
        context: { commandLine: "git ", cursorIndex: 4 },
      });
      writeFileSync(join(runtime.root, "completions.json"), JSON.stringify(result, null, 2));
      expect(JSON.stringify(result)).toContain("commit");
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
  it(
    "consumes official single-line, multiline and location problem matchers from actual task output",
    { timeout: 60_000 },
    async () => {
      const runtime = await fixture(["less", "scss", "cpp", "typescript-language-features"]);
      try {
        const scenarios = [
          {
            matcher: "$lessc",
            owner: "lessc",
            file: "style.less",
            text: `Unknown color in ${join(runtime.project, "style.less")} on line 3, column 5\n`,
            line: 2,
            character: 4,
            message: "Unknown color",
          },
          {
            matcher: "$node-sass",
            owner: "node-sass",
            file: "style.scss",
            text:
              JSON.stringify(
                {
                  status: 1,
                  file: join(runtime.project, "style.scss"),
                  line: 4,
                  column: 2,
                  message: "Missing brace",
                  formatted: "Error",
                },
                null,
                2,
              ) + "\n",
            line: 3,
            character: 1,
            message: "Missing brace",
          },
          {
            matcher: "$nvcc",
            owner: "cuda-cpp",
            file: "kernel.cu",
            text: "kernel.cu(7): error: expected a declaration\n",
            line: 6,
            character: 0,
            message: "expected a declaration",
          },
          {
            matcher: "$tsc",
            owner: "typescript",
            file: "main.ts",
            text: "main.ts(2,3): error TS2322: Type mismatch\n",
            line: 1,
            character: 2,
            message: "Type mismatch",
          },
        ];
        for (const scenario of scenarios) {
          expect(
            await runtime.host.executeCommand(
              "tasks",
              "task.problem",
              scenario.matcher,
              scenario.text,
            ),
          ).toEqual({ exitCode: 1, active: 0 });
          const diagnostics = [...runtime.diagnostics]
            .filter(([key]) => key.startsWith(`${scenario.owner}:`))
            .flatMap(([, values]) => values);
          expect(diagnostics).toMatchObject([
            {
              message: scenario.message,
              range: { start: { line: scenario.line, character: scenario.character } },
            },
          ]);
        }
        expect(await runtime.host.executeCommand("tasks", "task.terminate")).toBe(0);
        expect(runtime.errors).toEqual([]);
        writeFileSync(
          join(runtime.root, "task-diagnostics.json"),
          JSON.stringify([...runtime.diagnostics], null, 2),
        );
      } finally {
        await runtime.dispose();
      }
    },
  );
});
