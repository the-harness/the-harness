import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createMainThreadTerminal } from "../../packages/vscode-ext-host/src/main-thread/terminal.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("finishes rejected terminal launches and keeps the extension host available", async () => {
  const root = await mkdtemp(join(tmpdir(), "vscode-launch-failure-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "terminal");
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "terminal-launch-failure";
  const rejectLaunch = Promise.withResolvers<null>();
  const terminal = {
    async create(options: { title: string }) {
      if (options.title === "rejected") return await rejectLaunch.promise;
      if (options.title === "disconnected") throw new Error("Terminal connection closed");
      return { id: "working-pty", pid: 4321 };
    },
    async kill() {},
  };
  const main = createMainThreadTerminal(terminal as never, {} as never, (id, name, args) =>
    host.executeCommand(id, name, ...args),
  );
  const terminalCalls: string[] = [];
  const stop = host.onMainThreadCall(async (id, method, args, requestId) => {
    try {
      if (method.startsWith("terminal.")) {
        terminalCalls.push(method);
        await main(id, method, args);
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
        name: "terminal",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, "extension.cjs"),
      `
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  const terminals = new Map();
  const events = [];
  subscriptions.push(
    v.window.onDidOpenTerminal(t => events.push(
      ["open", t.name, terminals.get(t.name) === t, v.window.terminals.includes(t), !!t.exitStatus]
    )),
    v.window.onDidCloseTerminal(t => events.push(
      ["close", t.name, terminals.get(t.name) === t, v.window.terminals.includes(t),
        v.TerminalExitReason[t.exitStatus.reason], t.exitStatus.code ?? null]
    )),
    v.commands.registerCommand("test.create", (name, queue) => {
      const terminal = v.window.createTerminal({ name });
      terminals.set(name, terminal);
      if (queue) {
        terminal.sendText("pending input");
        terminal.show();
        terminal.dispose();
      }
      return v.window.terminals.includes(terminal);
    }),
    v.commands.registerCommand("test.processId", async name => (await terminals.get(name).processId) ?? null),
    v.commands.registerCommand("test.state", () => ({ events, names: v.window.terminals.map(t => t.name) })),
  );
};
`,
    );
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");

    expect(await run("test.create", "rejected", true)).toBe(true);
    expect(await run("test.state")).toEqual({ events: [], names: ["rejected"] });
    rejectLaunch.resolve(null);
    expect(await run("test.processId", "rejected")).toBeNull();
    expect(await run("test.create", "disconnected", true)).toBe(true);
    expect(await run("test.processId", "disconnected")).toBeNull();
    expect(await run("test.state")).toEqual({
      events: [
        ["open", "rejected", true, true, false],
        ["close", "rejected", true, false, "Process", null],
        ["close", "disconnected", true, false, "Unknown", null],
      ],
      names: [],
    });
    expect(terminalCalls).toEqual(["terminal.create", "terminal.create"]);

    expect(await run("test.create", "working")).toBe(true);
    expect(await run("test.processId", "working")).toBe(4321);
    expect(await run("test.state")).toMatchObject({ names: ["working"] });
  } finally {
    rejectLaunch.resolve(null);
    stop();
    await main.reset();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
