import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const source = String.raw`
const vscode = require("vscode");
const fs = require("node:fs");
let finishInflight;
exports.activate = async context => {
  await vscode.commands.executeCommand("workbench.action.save");
  const count = context.globalState.get("activations", 0) + 1;
  await context.globalState.update("activations", count);
  await context.workspaceState.update("temporary", true);
  await context.workspaceState.update("temporary", undefined);
  const dependency = vscode.extensions.getExtension("AUDIT.DEPENDENCY");
  const exported = await dependency.activate();
  let configChanges = [];
  let previousEditor;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => configChanges.push({ setting: event.affectsConfiguration("audit.settings"), other: event.affectsConfiguration("other") })));
  context.subscriptions.push(vscode.commands.registerCommand("audit.state", function() {
    const config = vscode.workspace.getConfiguration("audit");
    return {
      count, keys: context.workspaceState.keys(), bound: this.value,
      config: config.get("settings"), inspect: config.inspect("settings"), has: config.has("settings"), sync: !(config.get("settings") instanceof Promise), configChanges,
      language: vscode.env.language,
      own: { id: context.extension.id, active: context.extension.isActive, uri: context.extensionUri.toString(), absolute: context.asAbsolutePath("asset.txt") },
      dependency: { active: dependency.isActive, same: exported === dependency.exports, result: exported.answer() },
      all: vscode.extensions.all.map(item => item.id),
    };
  }, { value: "bound" }));
  context.subscriptions.push(vscode.commands.registerCommand("audit.update", () => vscode.workspace.getConfiguration("audit").update("settings", undefined, true)));
  context.subscriptions.push(vscode.commands.registerCommand("audit.commands", async () => {
    let duplicate = false;
    try { vscode.commands.registerCommand("audit.state", () => {}); } catch { duplicate = true; }
    const throwing = vscode.commands.registerCommand("audit.throw", () => { throw new Error("expected failure"); });
    let returned;
    try { returned = vscode.commands.executeCommand("audit.throw"); } catch { return { threwSynchronously: true }; }
    let rejected = false;
    await returned.catch(() => { rejected = true; });
    throwing.dispose();
    return { duplicate, rejected, commands: await vscode.commands.getCommands(true) };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("audit.editor", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file("/project/file.ts"));
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: true });
    previousEditor = editor;
    const same = document === editor.document && editor === vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(1, 3, 0, 1);
    let builder;
    const applied = await editor.edit(edit => { builder = edit; edit.replace(new vscode.Range(0, 0, 0, 3), "new"); });
    let lateRejected = false;
    try { builder.insert(new vscode.Position(0, 0), "late"); } catch { lateRejected = true; }
    return { same, applied, lateRejected, reversed: editor.selection.isReversed, text: editor.document.getText(), line: editor.document.lineAt(1).text };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("audit.reopen", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file("/project/file.ts"));
    const editor = await vscode.window.showTextDocument(document);
    return { sameDocument: editor.document === document, newEditor: editor !== previousEditor, closed: editor.document.isClosed, oldClosed: previousEditor.document.isClosed };
  }));
  context.subscriptions.push(vscode.commands.registerTextEditorCommand("audit.editorCommand", (editor, edit, text) => edit.insert(new vscode.Position(0, 0), text)));
  context.subscriptions.push(vscode.commands.registerCommand("audit.wait", () => new Promise(() => {})));
  context.subscriptions.push(vscode.commands.registerCommand("audit.inflight", () => new Promise(resolve => { finishInflight = () => resolve("released during deactivate"); })));
  context.subscriptions.push(vscode.commands.registerCommand("audit.inflightStarted", () => !!finishInflight));
  context.subscriptions.push({ dispose: () => fs.writeFileSync(context.asAbsolutePath("disposed"), "yes") });
};
exports.deactivate = () => { finishInflight?.(); fs.writeFileSync(__dirname + "/deactivated", "yes"); };
`;

async function start() {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-lifecycle-"));
  for (const [name, contents, extra] of [
    [
      "main",
      source,
      {
        activationEvents: ["*"],
        extensionDependencies: ["audit.dependency"],
        contributes: { commands: [{ command: "audit.state", title: "State" }] },
      },
    ],
    [
      "dependency",
      'import * as vscode from "vscode"; import { Position } from "vscode"; await Promise.resolve(); export const activate = () => ({ answer: () => vscode.Position === Position ? 42 : 0 });',
      {},
    ],
  ] as const) {
    const directory = join(root, name);
    mkdirSync(directory);
    const entry = name === "dependency" ? "extension.mjs" : "extension.js";
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name,
        version: "1.0.0",
        main: name === "dependency" ? entry : "./extension",
        ...extra,
      }),
    );
    writeFileSync(join(directory, entry), contents);
  }
  const hostFixture = await createExtensionHostFixture();
  const host = hostFixture.service;
  const state = new Map<string, Record<string, unknown>>();
  const calls: { method: string; args: unknown[] }[] = [];
  const document = {
    uri: { scheme: "file", path: "/project/file.ts" },
    text: "old\nsecond",
    version: 1,
    languageId: "typescript",
    isDirty: false,
    eol: 1,
  };
  const editor = {
    document,
    selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }],
    visibleRanges: [],
    options: { tabSize: 2, insertSpaces: true },
  };
  const off = host.onMainThreadCall(async (sessionId, method, args, requestId) => {
    if (!requestId) return;
    calls.push({ method, args });
    let result: unknown;
    if (method.startsWith("memento.")) {
      const [id, scope, key, value, remove] = args as [string, string, string, unknown, boolean?];
      const bucket = `${scope === "global" ? scope : sessionId}:${id}`;
      const values = state.get(bucket) ?? {};
      if (method === "memento.load") result = values;
      else {
        if (remove) delete values[key];
        else values[key] = value;
        state.set(bucket, values);
      }
    } else if (method === "commands.getCommands") result = ["workbench.action.save", "_private"];
    else if (method === "workspace.openTextDocument") result = document;
    else if (method === "window.showTextDocument") result = editor;
    else if (method === "editor.edit") {
      if (args[1] !== document.version) result = false;
      else {
        const edits = args[2] as {
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          text: string;
        }[];
        for (const edit of edits)
          document.text =
            document.text.slice(0, edit.range.start.character) +
            edit.text +
            document.text.slice(edit.range.end.character);
        document.version++;
        document.isDirty = true;
        result = { applied: true, document };
      }
    }
    host.resolveMainCall(requestId, result);
  });
  const initialize = () =>
    host.startSession("session", ["/project"], {
      configuration: {
        defaults: { "audit.settings": { default: true, shared: "default" } },
        user: { "audit.settings": { user: true } },
        workspace: { "audit.settings": { shared: "workspace" } },
      },
      documents: [document],
      editors: { active: editor, visible: [editor] },
      environment: { language: "zh-cn" },
    });
  try {
    await host.scanExtensions(root);
    await initialize();
  } catch (error) {
    await hostFixture.dispose("session");
    off();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    host,
    calls,
    initialize,
    async dispose() {
      await hostFixture.dispose("session");
      off();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("VS Code extension lifecycle across the worker boundary", () => {
  it("activates dependencies, exposes synchronous configuration and persists mementos on restart", async () => {
    const fixture = await start();
    try {
      const state = await fixture.host.executeCommand<Record<string, unknown>>(
        "session",
        "audit.state",
      );
      expect(state).toMatchObject({
        count: 1,
        keys: [],
        bound: "bound",
        sync: true,
        has: true,
        language: "zh-cn",
        config: { default: true, user: true, shared: "workspace" },
        dependency: { active: true, same: true, result: 42 },
        own: { id: "audit.main", active: true },
      });
      expect(state.all).toEqual(expect.arrayContaining(["audit.main", "audit.dependency"]));
      expect(state.inspect).toMatchObject({
        defaultValue: { default: true, shared: "default" },
        globalValue: { user: true },
        workspaceValue: { shared: "workspace" },
      });
      await fixture.host.executeCommand("session", "__config.sync", {
        defaults: {},
        user: {},
        workspace: { "audit.settings": "new" },
      });
      expect(await fixture.host.executeCommand("session", "audit.state")).toMatchObject({
        config: "new",
        configChanges: [{ setting: true, other: false }],
      });
      await fixture.host.executeCommand("session", "audit.update");
      expect(fixture.calls.find((call) => call.method === "workspace.updateConfig")?.args).toEqual([
        "audit.settings",
        null,
        "user",
        true,
      ]);
      const inflight = fixture.host.executeCommand("session", "audit.inflight");
      expect(await fixture.host.executeCommand("session", "audit.inflightStarted")).toBe(true);
      const released = expect(inflight).resolves.toBe("released during deactivate");
      await fixture.host.stopSession("session");
      await released;
      expect(readFileSync(join(fixture.root, "main", "deactivated"), "utf8")).toBe("yes");
      expect(readFileSync(join(fixture.root, "main", "disposed"), "utf8")).toBe("yes");
      await fixture.initialize();
      expect(await fixture.host.executeCommand("session", "audit.state")).toMatchObject({
        count: 2,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("preserves editor identity and routes standard edit builders and command semantics", async () => {
    const fixture = await start();
    try {
      await fixture.host.executeCommand("session", "audit.state");
      expect(await fixture.host.executeCommand("session", "audit.editor")).toEqual({
        same: true,
        applied: true,
        lateRejected: true,
        reversed: true,
        text: "new\nsecond",
        line: "second",
      });
      await fixture.host.executeCommand("session", "audit.editorCommand", "prefix");
      const edits = fixture.calls.filter((call) => call.method === "editor.edit");
      expect(edits).toHaveLength(2);
      expect(edits.map((call) => call.args[1])).toEqual([1, 2]);
      expect(edits[1]?.args[2]).toMatchObject([
        {
          text: "prefix",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ]);
      await fixture.host.executeCommand("session", "__ws.onDidCloseTextDocument", {
        uri: { scheme: "file", path: "/project/file.ts" },
        text: "prefixnew\nsecond",
        version: 3,
        languageId: "typescript",
        eol: 1,
        isDirty: true,
      });
      await fixture.host.executeCommand("session", "__win.onDidChangeActiveTextEditor", null);
      await fixture.host.executeCommand("session", "__win.onDidChangeVisibleTextEditors", []);
      expect(await fixture.host.executeCommand("session", "audit.reopen")).toEqual({
        sameDocument: true,
        newEditor: true,
        closed: false,
        oldClosed: true,
      });
      expect(await fixture.host.executeCommand("session", "audit.commands")).toMatchObject({
        duplicate: true,
        rejected: true,
        commands: expect.arrayContaining(["workbench.action.save", "audit.state"]),
      });
      const pending = fixture.host.executeCommand("session", "audit.wait");
      const rejected = expect(pending).rejects.toThrow("Extension host stopped");
      await fixture.host.stopSession("session");
      await rejected;
    } finally {
      await fixture.dispose();
    }
  });
});
