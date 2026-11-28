import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtHostRpcContract } from "../../packages/vscode-ext-host/src/rpc.ts";
import { decodeExtHostError } from "../../packages/vscode-ext-host/src/wire-error.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("keeps workspace workers running while switching their foreground registrations", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-client-lifecycle-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const [name, event] of [
    ["startup", "onStartupFinished"],
    ["initial", "onLanguage:fixture"],
    ["later", "onLanguage:later"],
  ]) {
    const directory = join(extensions, name!);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name,
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: [event],
      }),
    );
    writeFileSync(
      join(directory, "extension.cjs"),
      name === "startup"
        ? `
      const vscode = require("vscode"); let context;
      exports.activate = async ctx => {
        context = ctx; await ctx.globalState.update("starts", ctx.globalState.get("starts", 0) + 1);
        ctx.subscriptions.push(vscode.commands.registerCommand("audit.startup", () => ({ starts: ctx.globalState.get("starts"), stopped: ctx.globalState.get("stopped", false) })));
        vscode.commands.registerCommand("audit.unsubscribed", () => "works");
        vscode.commands.registerCommand("audit.read", async file => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file))));
        vscode.commands.registerCommand("audit.openTextDocument", async file => {
          try {
            return (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText();
          } catch (error) {
            if (!(error instanceof vscode.FileSystemError)) throw new Error("Expected a FileSystemError in the extension worker");
            throw error;
          }
        });
        vscode.commands.registerCommand("audit.open", async file => {
          const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
          return { text: editor.document.getText(), viewColumn: editor.viewColumn };
        });
        vscode.commands.registerCommand("audit.pick", () => vscode.window.showQuickPick(["one"]));
        let count = 0;
        vscode.commands.registerCommand("audit.counter", () => ++count);
        vscode.window.createWebviewPanel("fixture", "Fixture", 1, {});
        ctx.subscriptions.push(vscode.window.registerTreeDataProvider("audit.tree", { getChildren: () => ["item"], getTreeItem: label => ({ label }) }));
        const initialColorTheme = vscode.window.activeColorTheme.kind;
        const colorThemeChanges = [];
        ctx.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(theme => {
          if (theme !== vscode.window.activeColorTheme) throw new Error("Theme event preceded the getter update");
          colorThemeChanges.push(theme);
        }));
        vscode.commands.registerCommand("audit.colorTheme", () => ({
          initial: initialColorTheme,
          current: vscode.window.activeColorTheme.kind,
          changes: colorThemeChanges,
        }));
        const changed = new vscode.EventEmitter();
        vscode.authentication.registerAuthenticationProvider("fixture-auth", "Fixture", { onDidChangeSessions: changed.event, getSessions: async () => [], createSession: async () => { throw new Error("not requested"); }, removeSession: async () => {} });
      };
      exports.deactivate = async () => { await new Promise(resolve => setTimeout(resolve, 50)); await context.globalState.update("stopped", true); };
    `
        : `const vscode = require("vscode"); exports.activate = context => { if (!vscode.workspace.textDocuments.some(document => document.languageId === ${JSON.stringify(name === "initial" ? "fixture" : "later")})) throw new Error("Language activation ran before document synchronization"); context.subscriptions.push(vscode.commands.registerCommand("audit.${name}", () => true)); };`,
    );
  }
  const themeDirectory = join(extensions, "themes");
  mkdirSync(themeDirectory);
  const themes = [
    { id: "Audit HC Light", uiTheme: "hc-light", background: "#ffffff" },
    { id: "Audit HC Dark", uiTheme: "hc-black", background: "#000000" },
    { id: "Audit Dark", uiTheme: "vs-dark", background: "#242424" },
    { id: "Audit Dark Alternate", uiTheme: "vs-dark", background: "#333333" },
    { id: "Audit Light", uiTheme: "vs", background: "#eeeeee" },
  ].map(({ id, uiTheme, background }, index) => {
    const path = `./theme-${index}.json`;
    writeFileSync(
      join(themeDirectory, path),
      JSON.stringify({
        colors: { "editor.background": background, "editor.foreground": "#888888" },
        tokenColors: [],
      }),
    );
    return { id, label: id, uiTheme, path };
  });
  writeFileSync(
    join(themeDirectory, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "themes",
      version: "1.0.0",
      contributes: { themes },
    }),
  );

  const fixture = await createExtensionHostFixture();
  const queues = new Map<string, unknown[]>();
  const wake = new Map<string, () => void>();
  const rpcCalls: { method: string; sessionId?: string; command?: string }[] = [];
  const off = fixture.service.onMainThreadCall(async (sessionId, method, args, requestId) => {
    const queue = queues.get(sessionId) ?? [];
    queue.push({ sessionId, method, args, requestId });
    queues.set(sessionId, queue);
    wake.get(sessionId)?.();
  });
  const stopped: string[] = [];
  fixture.scope.run(() =>
    fixture.service.hooks.sessionStopped.use((id, next) => {
      stopped.push(id);
      return next();
    }),
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  await page.exposeFunction(
    "lifecycleRpc",
    async (method: string, input: Record<string, unknown>) => {
      rpcCalls.push({
        method,
        sessionId: input.sessionId as string | undefined,
        command: input.command as string | undefined,
      });
      const session = String(input.sessionId);
      if (method === "getContributions") return fixture.service.getContributions();
      if (method === "startSession")
        return fixture.service.startSession(session, input.workspaceRoots as string[], {
          ...(input.initialState as object),
          storageRoot: join(root, "storage"),
        });
      if (method === "stopSession") return fixture.service.stopSession(session);
      if (method === "activateByEvent")
        return fixture.service.activateByEvent(session, String(input.event));
      if (method === "executeCommand") {
        if (input.command === "__ws.onDidOpenTextDocument")
          await new Promise((resolve) => setTimeout(resolve, 100));
        return fixture.service.executeCommand(
          session,
          String(input.command),
          ...((input.args as unknown[]) ?? []),
        );
      }
      if (method === "resolveMainCall") {
        const reply = ExtHostRpcContract.endpoints.resolveMainCall.input.parse(input);
        return fixture.service.resolveMainCall(
          reply.requestId,
          reply.result,
          reply.error === undefined
            ? undefined
            : decodeExtHostError({ ...reply, error: reply.error }),
        );
      }
      throw new Error(`Unexpected client RPC ${method}`);
    },
  );
  await page.exposeFunction("lifecycleEvents", async (session: string) => {
    if (!queues.get(session)?.length)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        wake.set(session, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    wake.delete(session);
    const events = queues.get(session) ?? [];
    queues.set(session, []);
    return events;
  });
  try {
    await fixture.service.scanExtensions(extensions);
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(async (root) => {
      const client = await import("/tests/vscode-client-lifecycle.fixture.ts");
      client.setColorTheme("Audit HC Light");
      client.start(root);
    }, root);
    const snapshot = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-client-lifecycle.fixture.ts")).snapshot(),
      );
    await expect
      .poll(() => rpcCalls.some(({ method }) => method === "getContributions"))
      .toBe(true);
    expect(rpcCalls.some(({ method }) => method === "startSession")).toBe(false);
    await expect.poll(async () => (await snapshot()).colorTheme).toBe("Audit HC Light");
    await page.evaluate(async () =>
      (await import("/tests/vscode-client-lifecycle.fixture.ts")).select("first"),
    );
    await expect.poll(async () => (await snapshot()).commands).toContain("audit.startup");
    await expect.poll(async () => (await snapshot()).commands).toContain("audit.initial");
    await expect.poll(async () => (await snapshot()).panels.length).toBe(1);
    expect((await snapshot()).commands).not.toContain("audit.later");
    await page.evaluate(
      async (root) =>
        (await import("/tests/vscode-client-lifecycle.fixture.ts")).openLanguage(root, "later"),
      root,
    );
    await expect.poll(async () => (await snapshot()).commands).toContain("audit.later");
    const first = await snapshot(),
      oldPanel = first.panels[0]!;
    const firstHostId = rpcCalls.find((call) => call.method === "startSession")!.sessionId!;
    const colorTheme = (hostId: string) =>
      fixture.service.executeCommand(hostId, "audit.colorTheme");
    const setColorTheme = (id: string) =>
      page.evaluate(
        async (id) => (await import("/tests/vscode-client-lifecycle.fixture.ts")).setColorTheme(id),
        id,
      );
    expect(await colorTheme(firstHostId)).toEqual({ initial: 4, current: 4, changes: [] });
    await setColorTheme("Audit HC Dark");
    await expect
      .poll(() => colorTheme(firstHostId))
      .toEqual({
        initial: 4,
        current: 3,
        changes: [{ kind: 3 }],
      });
    await expect(
      fixture.service.executeCommand(
        firstHostId,
        "audit.open",
        join(root, "first", "initial.fixture"),
      ),
    ).resolves.toEqual({ text: "initial", viewColumn: 1 });
    await page.evaluate(async () =>
      (await import("/tests/vscode-client-lifecycle.fixture.ts")).select("second"),
    );
    const execute = (command: string) =>
      page.evaluate(
        async (name) => (await import("/tests/vscode-client-lifecycle.fixture.ts")).execute(name),
        command,
      );
    await expect.poll(() => execute("audit.startup")).toEqual({ starts: 2, stopped: false });
    expect(await execute("audit.colorTheme")).toEqual({ initial: 3, current: 3, changes: [] });
    await setColorTheme("Audit Dark");
    await expect
      .poll(() => execute("audit.colorTheme"))
      .toEqual({
        initial: 3,
        current: 2,
        changes: [{ kind: 2 }],
      });
    await setColorTheme("Audit Dark Alternate");
    await expect
      .poll(() => execute("audit.colorTheme"))
      .toEqual({
        initial: 3,
        current: 2,
        changes: [{ kind: 2 }, { kind: 2 }],
      });
    await setColorTheme("Audit Light");
    await expect
      .poll(() => execute("audit.colorTheme"))
      .toEqual({
        initial: 3,
        current: 1,
        changes: [{ kind: 2 }, { kind: 2 }, { kind: 1 }],
      });
    await expect
      .poll(() => colorTheme(firstHostId))
      .toEqual({
        initial: 4,
        current: 1,
        changes: [{ kind: 3 }, { kind: 2 }, { kind: 2 }, { kind: 1 }],
      });
    await expect.poll(async () => (await snapshot()).panels.length).toBe(1);
    expect((await snapshot()).panels).not.toContain(oldPanel);
    expect((await snapshot()).tree).toEqual(["audit.tree"]);
    expect((await snapshot()).commands).not.toContain("audit.later");
    expect(stopped).toEqual([]);
    const firstFile = join(root, "first", "data.txt");
    await expect(
      fixture.service.executeCommand(firstHostId, "audit.read", firstFile),
    ).resolves.toBe(firstFile);
    const secondFile = join(root, "second", "data.txt");
    await expect(
      fixture.service.executeCommand(firstHostId, "audit.openTextDocument", secondFile),
    ).rejects.toMatchObject({
      code: "NoPermissions",
      message: `Path is outside active workspace roots: ${secondFile}`,
    });
    await expect(fixture.service.executeCommand(firstHostId, "audit.pick")).rejects.toThrow(
      "requires its workspace to be active",
    );
    expect(await fixture.service.executeCommand(firstHostId, "audit.counter")).toBe(1);
    expect(await execute("audit.counter")).toBe(1);
    const callsBefore = rpcCalls.length;
    await page.evaluate(
      async (id) => (await import("/tests/vscode-client-lifecycle.fixture.ts")).post(id),
      oldPanel,
    );
    expect(
      rpcCalls.slice(callsBefore).some((call) => call.command === `__webview.message.${oldPanel}`),
    ).toBe(false);

    await page.evaluate(async () =>
      (await import("/tests/vscode-client-lifecycle.fixture.ts")).select("first"),
    );
    await expect.poll(async () => (await snapshot()).panels).toEqual([oldPanel]);
    expect((await snapshot()).commands).toContain("audit.later");
    expect(await execute("audit.counter")).toBe(2);
    const hosts = rpcCalls.filter((call) => call.method === "startSession");
    expect(hosts).toHaveLength(2);
    expect(stopped).toEqual([]);

    await page.evaluate(async () =>
      (await import("/tests/vscode-client-lifecycle.fixture.ts")).dispose(),
    );
    await expect
      .poll(() => [...stopped].sort())
      .toEqual(hosts.map((call) => call.sessionId).sort());
    expect((await snapshot()).panels).toEqual([]);
    expect((await snapshot()).commands).toEqual([]);
    expect((await snapshot()).tree).toEqual([]);
    expect((await snapshot()).messages).toEqual([]);
    writeFileSync(join(root, "client-rpc.json"), JSON.stringify(rpcCalls, null, 2));
  } finally {
    await page.evaluate(async () =>
      (await import("/tests/vscode-client-lifecycle.fixture.ts")).dispose(),
    );
    await fixture.dispose(
      ...rpcCalls.filter((call) => call.method === "startSession").map((call) => call.sessionId!),
    );
    off();
  }
  expect(await getBrowserErrors()).toEqual([]);
});
