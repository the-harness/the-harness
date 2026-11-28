import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer } from "vite-plus";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

test("reports PTY exits and terminal removals to the owning VS Code extension", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const artifacts = resolve("temp/artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-terminal-exit-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "exit");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "exit",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(extension, "extension.cjs"),
    String.raw`
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  const terminals = new Map();
  const output = new Map();
  const closed = [];
  subscriptions.push(
    v.window.onDidCloseTerminal(terminal => closed.push({
      name: terminal.name,
      reason: v.TerminalExitReason[terminal.exitStatus?.reason],
      code: terminal.exitStatus?.code ?? null,
      same: terminals.get(terminal.name) === terminal,
      listed: v.window.terminals.includes(terminal),
    })),
    v.window.onDidWriteTerminalData(({ terminal, data }) => {
      output.set(terminal.name, (output.get(terminal.name) ?? "") + data);
    }),
    v.commands.registerCommand("fixture.open", async name => {
      const terminal = v.window.createTerminal({
        name, cwd: __dirname, shellPath: "/bin/sh", shellArgs: ["-s"],
      });
      terminals.set(name, terminal);
      return await terminal.processId;
    }),
    v.commands.registerCommand("fixture.input", (name, text) => terminals.get(name).sendText(text)),
    v.commands.registerCommand("fixture.dispose", name => terminals.get(name).dispose()),
    v.commands.registerCommand("fixture.output", name => output.get(name) ?? ""),
    v.commands.registerCommand("fixture.closed", () => closed),
  );
};
`,
  );
  const config = join(root, "vite.config.ts");
  await writeFile(
    config,
    `import base from ${JSON.stringify(resolve("apps/web/vite.config.ts"))}; export default {...base, plugins:base.plugins.filter(p=>p?.name!=="harness:server-api")};`,
  );
  const vite = await createServer({
    configFile: config,
    root: resolve("apps/web"),
    cacheDir: join(root, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, strictPort: true, watch: null },
  });
  const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("terminal.")) return { handled: false };
    const handled = await page.evaluate(
      async (input) =>
        (await import("/tests/vscode-terminal-state.fixture.ts")).dispatch(
          input.session,
          input.method,
          input.args,
        ),
      { session, method, args },
    );
    if (!handled) throw new Error(`Unhandled terminal call: ${method}`);
    return { handled: true, result: true };
  });
  const session = "terminal-exit-status";
  const run = (command: string, ...args: unknown[]) =>
    runtime.host.executeCommand(session, command, ...args);
  const status = (name: string, reason: string, code: number | null) => ({
    name,
    reason,
    code,
    same: true,
    listed: false,
  });
  const closed = () => run("fixture.closed");
  const open = async (name: string) => {
    expect(await run("fixture.open", name)).toBeGreaterThan(0);
    await run("fixture.input", name, "printf 'TERMINAL_EXIT_READY\\n'");
    await expect.poll(() => run("fixture.output", name)).toMatch(/\r?\nTERMINAL_EXIT_READY\r?\n/);
  };

  try {
    await vite.listen();
    const { port } = vite.httpServer!.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    await page.exposeFunction(
      "executeTerminalCommand",
      (id: string, command: string, args: unknown[]) =>
        runtime.host.executeCommand(id, command, ...args),
    );
    await page.goto(`${origin}/tests/vscode-terminal-state.fixture.html`);
    await runtime.host.scanExtensions(extensions);
    await runtime.host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await runtime.host.activateByEvent(session, "onStartupFinished");

    for (const [name, code] of [
      ["success", 0],
      ["failure", 7],
    ] as const) {
      await open(name);
      await run("fixture.input", name, `exit ${code}`);
      await expect.poll(closed).toContainEqual(status(name, "Process", code));
    }
    await open("extension");
    await run("fixture.dispose", "extension");
    await expect.poll(closed).toContainEqual(status("extension", "Extension", null));

    await open("user");
    const inventory = await page.request.get(`${origin}/api/terminals`);
    const entries = (await inventory.json()) as { id: string; title: string }[];
    for (const name of ["success", "failure", "user"]) {
      const entry = entries.find((entry) => entry.title === name)!;
      const removed = await page.request.delete(
        `${origin}/api/terminals/${encodeURIComponent(entry.id)}`,
      );
      expect(removed.ok()).toBe(true);
    }
    await expect
      .poll(closed)
      .toEqual([
        status("success", "Process", 0),
        status("failure", "Process", 7),
        status("extension", "Extension", null),
        status("user", "User", null),
      ]);
    expect(runtime.errors).toEqual([]);
  } finally {
    await page
      .evaluate(async () => (await import("/tests/vscode-terminal-state.fixture.ts")).dispose())
      .catch(() => undefined);
    await runtime.dispose(session);
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});
