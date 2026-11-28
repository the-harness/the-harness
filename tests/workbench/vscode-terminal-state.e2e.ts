import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer } from "vite-plus";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("headless extension sendText and actual Xterm input execute in the PTY and update terminal state once", async ({
  page,
}) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/terminal-state-browser-"));
  const extension = join(root, "extensions/probe");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "terminal",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:terminal.createFixture"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    String.raw`
const v = require('vscode');
const terminals = [], initial = [], events = [], output = {};
exports.activate = context => {
  context.subscriptions.push(v.window.onDidChangeTerminalState(terminal=>events.push({name:terminal.name,interacted:terminal.state.isInteractedWith,same:terminals.includes(terminal)})));
  context.subscriptions.push(v.window.onDidWriteTerminalData(event=>output[event.terminal.name]=(output[event.terminal.name]||'')+event.data));
  context.subscriptions.push(v.commands.registerCommand('terminal.createFixture',async ()=>{
    for(const name of ['Headless fixture','Keyboard fixture']) {
      const terminal = v.window.createTerminal({name,shellPath:'/bin/sh',shellArgs:['-s'],cwd:__dirname});
      terminals.push(terminal); initial.push(terminal.state); context.subscriptions.push(terminal);
      await terminal.processId;
    }
    return terminals.map(t=>({name:t.name,state:t.state}));
  }));
  context.subscriptions.push(v.commands.registerCommand('terminal.sendFixture',()=>terminals[0].sendText("printf 'HEADLESS_INPUT_OK\n'")));
  context.subscriptions.push(v.commands.registerCommand('terminal.inspectFixture',()=>({events,output,initial,states:terminals.map(t=>t.state)})));
};
`,
  );
  const config = join(root, "vite.config.ts");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(resolve("apps/web/vite.config.ts"))}; export default {...base, plugins:base.plugins.filter(p=>p?.name!=="harness:server-api")};`,
  );
  const vite = await createServer({
    configFile: config,
    root: resolve("apps/web"),
    cacheDir: join(root, "vite-cache"),
    server: { host: "127.0.0.1", port: 5187, strictPort: true, watch: null },
  });
  const runtime = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("terminal.")) return { handled: false };
    const handled = await page.evaluate(
      async ({ session, method, args }) =>
        (await import("/tests/vscode-terminal-state.fixture.ts")).dispatch(session, method, args),
      { session, method, args },
    );
    if (!handled) throw new Error(`Unhandled terminal call: ${method}`);
    return { handled: true, result: true };
  });
  await page.exposeFunction(
    "executeTerminalCommand",
    (session: string, command: string, args: unknown[]) =>
      runtime.host.executeCommand(session, command, ...args),
  );
  const browserErrors = await captureBrowserErrors(page);
  const inspect = () =>
    runtime.host.executeCommand<{
      events: { name: string; interacted: boolean; same: boolean }[];
      output: Record<string, string>;
      initial: { isInteractedWith: boolean }[];
      states: { isInteractedWith: boolean }[];
    }>("terminal", "terminal.inspectFixture");
  try {
    await vite.listen();
    await page.goto("http://127.0.0.1:5187/tests/vscode-terminal-state.fixture.html");
    await page.evaluate(async () => {
      await import("/tests/vscode-terminal-state.fixture.ts");
    });
    await runtime.host.scanExtensions(join(root, "extensions"));
    await runtime.host.startSession("terminal", [root], { storageRoot: join(root, "storage") });
    const created = await runtime.host.executeCommand("terminal", "terminal.createFixture");
    expect(created).toEqual([
      { name: "Headless fixture", state: { isInteractedWith: false, shell: "sh" } },
      { name: "Keyboard fixture", state: { isInteractedWith: false, shell: "sh" } },
    ]);
    await expect(page.locator(".xterm")).toHaveCount(0);
    await runtime.host.executeCommand("terminal", "terminal.sendFixture");
    await expect
      .poll(async () => (await inspect()).output["Headless fixture"])
      .toMatch(/\r?\nHEADLESS_INPUT_OK\r?\n/);
    expect((await inspect()).events).toEqual([
      { name: "Headless fixture", interacted: true, same: true },
    ]);
    await page.evaluate(async () =>
      (await import("/tests/vscode-terminal-state.fixture.ts")).mount("Keyboard fixture"),
    );
    const input = page.locator(".xterm-helper-textarea");
    await input.pressSequentially("printf 'KEYBOARD_INPUT_OK\\n'");
    await input.press("Enter");
    await expect
      .poll(async () => (await inspect()).output["Keyboard fixture"])
      .toMatch(/\r?\nKEYBOARD_INPUT_OK\r?\n/);
    const observed = await inspect();
    expect(observed.events).toEqual([
      { name: "Headless fixture", interacted: true, same: true },
      { name: "Keyboard fixture", interacted: true, same: true },
    ]);
    expect(observed.initial.map((item) => item.isInteractedWith)).toEqual([false, false]);
    expect(observed.states.map((item) => item.isInteractedWith)).toEqual([true, true]);
    await page.screenshot({ path: join(root, "terminal.png") });
    writeFileSync(join(root, "observed.json"), JSON.stringify(observed, null, 2));
    expect(runtime.errors).toEqual([]);
    expect(await browserErrors()).toEqual([]);
  } catch (error) {
    writeFileSync(
      join(root, "browser-errors.json"),
      JSON.stringify(await browserErrors().catch(() => []), null, 2),
    );
    throw error;
  } finally {
    await page
      .evaluate(async () => (await import("/tests/vscode-terminal-state.fixture.ts")).unmount())
      .catch(() => {});
    await runtime.dispose("terminal");
    await page
      .evaluate(async () => (await import("/tests/vscode-terminal-state.fixture.ts")).dispose())
      .catch(() => {});
    await page.goto("about:blank").catch(() => {});
    await vite.close();
  }
});
