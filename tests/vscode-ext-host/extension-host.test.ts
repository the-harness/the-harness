import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { scanExtensionsDir } from "../../packages/vscode-ext-host/src/manifest.ts";
import type { ExtensionHostService } from "../../packages/vscode-ext-host/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-ext-host-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface MainCall {
  readonly sessionId: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

class MainCallRecorder {
  readonly calls: MainCall[] = [];
  private readonly waiters: Array<{
    readonly predicate: (calls: readonly MainCall[]) => boolean;
    readonly resolve: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(call: MainCall): void {
    this.calls.push(call);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(this.calls)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  waitFor(predicate: (calls: readonly MainCall[]) => boolean, label: string): Promise<void> {
    if (predicate(this.calls)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = this.calls.map((call) => call.method).join(", ");
        reject(new Error(`timed out waiting for ${label}; saw: ${seen}`));
      }, 10_000);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  find(method: string): MainCall | undefined {
    return this.calls.find((call) => call.method === method);
  }

  all(method: string): MainCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

const CORE_ACTIVATE = `
const vscode = require("vscode");

exports.activate = async (context) => {
  vscode.window.showInformationMessage("demo activated");

  const status = vscode.window.createStatusBarItem(2, 7);
  status.text = "Ready";
  status.show();

  const output = vscode.window.createOutputChannel("Demo");
  output.appendLine("hello");
  output.append("world");

  let refreshListener;
  const tree = vscode.window.registerTreeDataProvider("demo.view", {
    onDidChangeTreeData(listener) { refreshListener = listener; return { dispose() {} }; },
    getChildren(element) {
      return element ? [] : [
        { label: "Alpha", collapsibleState: 1 },
        { label: "Beta" },
      ];
    },
    getTreeItem(element) {
      return { label: element.label, collapsibleState: element.collapsibleState ?? 0 };
    },
  });

  vscode.commands.registerCommand("demo.ping", async (value) => {
    const greeting = await vscode.workspace.getConfiguration("demo").get("greeting", "default");
    return { value, greeting };
  });
  vscode.commands.registerCommand("demo.refresh", () => {
    refreshListener();
    return "refreshed";
  });
  vscode.commands.registerCommand("demo.roots", () =>
    vscode.workspace.workspaceFolders.map((folder) => folder.uri.path),
  );

  context.subscriptions.push(status, output, tree);
  return { ok: true };
};
`;

const URI_HANDLER_SOURCE = `${CORE_ACTIVATE.replace(
  "context.subscriptions.push(status, output, tree);",
  `const uriHandler = vscode.window.registerUriHandler({
    handleUri(uri) {
      return {
        scheme: uri.scheme, authority: uri.authority, path: uri.path,
        query: uri.query, fragment: uri.fragment, text: uri.toString(true),
      };
    },
  });
  context.subscriptions.push(status, output, tree, uriHandler);`,
)}`;

const PROGRESS_SOURCE = `${CORE_ACTIVATE.replace(
  "context.subscriptions.push(status, output, tree);",
  `vscode.commands.registerCommand("demo.progress", () =>
    vscode.window.withProgress({ title: "Indexing" }, async (progress) => {
      progress.report({ message: "half", increment: 50 });
      return "done";
    }),
  );
  context.subscriptions.push(status, output, tree);`,
)}`;

const DECORATION_SOURCE = `${CORE_ACTIVATE.replace(
  "context.subscriptions.push(status, output, tree);",
  `const decorations = vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri) {
      return { badge: "M", tooltip: "modified " + uri.path };
    },
  });
  context.subscriptions.push(status, output, tree, decorations);`,
)}`;

function writeExtension(
  root: string,
  source: string,
  activationEvents: readonly string[] = ["onStartup"],
): string {
  const extensionsDir = join(root, "extensions");
  const extensionDir = join(extensionsDir, "demo");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, "package.json"),
    JSON.stringify({
      name: "demo",
      publisher: "acme",
      version: "1.0.0",
      main: "./extension.js",
      activationEvents,
      contributes: { commands: [{ command: "demo.ping", title: "Ping" }] },
    }),
  );
  writeFileSync(join(extensionDir, "extension.js"), source);
  return extensionsDir;
}

interface Harness {
  readonly service: ExtensionHostService;
  readonly recorder: MainCallRecorder;
  readonly sessionId: string;
  stop(): Promise<void>;
}

async function startHarness(
  source: string = CORE_ACTIVATE,
  activationEvents: readonly string[] = ["onStartup"],
): Promise<Harness> {
  const root = tempRoot();
  const extensionsDir = writeExtension(root, source, activationEvents);
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);

  const hostFixture = await createExtensionHostFixture();
  const service = hostFixture.service;
  const recorder = new MainCallRecorder();

  const off = service.onMainThreadCall(async (sessionId, method, args, requestId) => {
    recorder.push({ sessionId, method, args });
    let result: unknown;
    if (method === "workspace.getConfig") {
      const [key, defaultValue] = args as [string, unknown];
      result = key === "demo.greeting" ? "hello" : defaultValue;
    } else if (method.startsWith("__fileDeco.provide.")) {
      result = { badge: "M", tooltip: `modified ${String(args[0])}` };
    }
    service.resolveMainCall(requestId, result);
  });

  const sessionId = "session-1";
  try {
    await service.scanExtensions(extensionsDir);
    await service.startSession(sessionId, [workspaceDir], {
      configuration: { defaults: {}, user: { "demo.greeting": "hello" }, workspace: {} },
    });
  } catch (error) {
    await hostFixture.dispose(sessionId);
    off();
    throw error;
  }

  return {
    service,
    recorder,
    sessionId,
    async stop() {
      await hostFixture.dispose(sessionId);
      off();
    },
  };
}

describe("vscode extension host", () => {
  it("scans an extension directory and reads its manifest", async () => {
    const root = tempRoot();
    const extensionsDir = writeExtension(root, CORE_ACTIVATE);
    const manifests = await scanExtensionsDir(extensionsDir);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      id: "acme.demo",
      name: "demo",
      publisher: "acme",
      version: "1.0.0",
      activationEvents: ["onStartup"],
    });
    expect(manifests[0]!.main).toBe(join(extensionsDir, "demo/extension.js"));
  });

  it("activates an extension in a real child process and round-trips a command", async () => {
    const harness = await startHarness();
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");
      const result = await harness.service.executeCommand<{ value: string; greeting: string }>(
        harness.sessionId,
        "demo.ping",
        "payload",
      );
      expect(result).toEqual({ value: "payload", greeting: "hello" });

      const roots = await harness.service.executeCommand<string[]>(harness.sessionId, "demo.roots");
      expect(roots).toHaveLength(1);
      expect(roots[0]).toContain("workspace");

      expect(harness.recorder.find("workspace.getConfig")).toBeUndefined();
    } finally {
      await harness.stop();
    }
  });

  it("propagates status bar, output and tree contributions", async () => {
    const harness = await startHarness();
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");

      await harness.recorder.waitFor(
        (calls) =>
          calls.some((call) => call.method === "window.showMessage") &&
          calls.some((call) => call.method === "statusBar.create") &&
          calls.some((call) => call.method === "output.create") &&
          calls.some((call) => call.method === "tree.register"),
        "activation side effects",
      );

      expect(harness.recorder.find("window.showMessage")?.args).toEqual([
        "info",
        "demo activated",
        [],
      ]);
      expect(harness.recorder.find("statusBar.create")?.args).toEqual(["ext-status-1", "right", 7]);
      expect(harness.recorder.all("statusBar.update").map((call) => call.args)).toEqual([
        ["ext-status-1", { text: "Ready" }],
        ["ext-status-1", { visible: true }],
      ]);
      const outputCreate = harness.recorder.find("output.create")?.args;
      expect(outputCreate).toEqual([expect.any(String), "Demo"]);
      expect(harness.recorder.find("output.appendLine")?.args).toEqual([
        outputCreate?.[0],
        "hello",
      ]);
      expect(harness.recorder.find("output.append")?.args).toEqual([outputCreate?.[0], "world"]);
      expect(harness.recorder.find("tree.register")?.args).toEqual(["demo.view"]);

      const treeChildren = await harness.service.executeCommand<
        Array<{ id: string; label: string; collapsibleState: number }>
      >(harness.sessionId, "__tree.getChildren.demo.view");
      expect(treeChildren.map((node) => node.label)).toEqual(["Alpha", "Beta"]);
      expect(treeChildren[0]?.collapsibleState).toBe(1);

      const nested = await harness.service.executeCommand<unknown[]>(
        harness.sessionId,
        "__tree.getChildren.demo.view",
        treeChildren[0]!.id,
      );
      expect(nested).toEqual([]);

      await harness.service.executeCommand(harness.sessionId, "demo.refresh");
      await harness.recorder.waitFor(
        (calls) => calls.some((call) => call.method === "tree.refresh"),
        "tree refresh",
      );
      expect(harness.recorder.find("tree.refresh")?.args).toEqual(["demo.view"]);
    } finally {
      await harness.stop();
    }
  });

  it("auto-activates on a command event instead of waiting for onStartup", async () => {
    const harness = await startHarness(CORE_ACTIVATE, ["onCommand:demo.ping"]);
    try {
      const result = await harness.service.executeCommand(harness.sessionId, "demo.ping", "auto");
      expect(result).toEqual({ value: "auto", greeting: "hello" });
      await harness.recorder.waitFor(
        (calls) => calls.some((call) => call.method === "window.showMessage"),
        "activation from the command event",
      );
    } finally {
      await harness.stop();
    }
  });

  it("rejects commands after the session is stopped", async () => {
    const harness = await startHarness();
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");
      await harness.service.stopSession(harness.sessionId);
      await expect(harness.service.executeCommand(harness.sessionId, "demo.ping")).rejects.toThrow(
        "Extension host not started",
      );
      const root = tempRoot();
      mkdirSync(join(root, "workspace"));
      await expect(
        harness.service.startSession("session-2", [join(root, "workspace")]),
      ).resolves.toBeUndefined();
    } finally {
      await harness.service.stopSession("session-2");
      await harness.stop();
    }
  });

  it("registers a URI handler and delivers a parsed URI to it", async () => {
    const harness = await startHarness(URI_HANDLER_SOURCE);
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");
      await harness.recorder.waitFor(
        (calls) => calls.some((call) => call.method === "window.registerUriHandler"),
        "URI handler registration",
      );
      const id = String(harness.recorder.find("window.registerUriHandler")!.args[0]);
      const handled = await harness.service.executeCommand(
        harness.sessionId,
        `__uri.handle.${id}`,
        "command:demo/open?file=one#selection",
      );
      // VS Code URI contract: references/vscode/src/vs/base/common/uri.ts.
      expect(handled).toEqual({
        scheme: "command",
        authority: "",
        path: "demo/open",
        query: "file=one",
        fragment: "selection",
        text: "command:demo/open?file=one#selection",
      });
    } finally {
      await harness.stop();
    }
  });

  it("reports withProgress messages to the main thread and resolves its result", async () => {
    const harness = await startHarness(PROGRESS_SOURCE);
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");
      const result = await harness.service.executeCommand(harness.sessionId, "demo.progress");
      expect(result).toBe("done");
      await harness.recorder.waitFor(
        (calls) =>
          calls.some((call) => call.method === "window.progressStart") &&
          calls.some((call) => call.method === "window.progressReport") &&
          calls.some((call) => call.method === "window.progressEnd"),
        "progress notifications",
      );
      const id = harness.recorder.find("window.progressStart")!.args[0];
      expect(id).toEqual(expect.any(String));
      expect(id).not.toBe("");
      expect(
        harness.recorder.calls
          .filter((call) => call.method.startsWith("window.progress"))
          .map(({ method, args }) => ({ method, args })),
      ).toEqual([
        { method: "window.progressStart", args: [id, "Indexing", 15, false] },
        { method: "window.progressReport", args: [id, "Indexing", "half", 50] },
        { method: "window.progressEnd", args: [id] },
      ]);
    } finally {
      await harness.stop();
    }
  });

  it("provides file decorations for a requested path", async () => {
    const harness = await startHarness(DECORATION_SOURCE);
    try {
      await harness.service.activateByEvent(harness.sessionId, "onStartup");
      await harness.recorder.waitFor(
        (calls) => calls.some((call) => call.method === "window.registerFileDecorationProvider"),
        "file decoration registration",
      );
      const id = String(harness.recorder.find("window.registerFileDecorationProvider")!.args[0]);
      const decoration = await harness.service.executeCommand(
        harness.sessionId,
        `__fileDeco.provide.${id}`,
        "/tmp/changed.ts",
      );
      expect(decoration).toEqual({ badge: "M", tooltip: "modified /tmp/changed.ts" });
    } finally {
      await harness.stop();
    }
  });
});
