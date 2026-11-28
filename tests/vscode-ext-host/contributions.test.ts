import { describe, expect, it } from "vite-plus/test";
import { createMainThreadFileDecorations } from "../../packages/vscode-ext-host/src/main-thread/file-decorations.ts";
import { createMainThreadScm } from "../../packages/vscode-ext-host/src/main-thread/scm.ts";
import { createMainThreadTree } from "../../packages/vscode-ext-host/src/main-thread/tree.ts";
import { createMainThreadWebview } from "../../packages/vscode-ext-host/src/main-thread/webview.ts";

describe("main thread source control contributions", () => {
  it("tracks provider input, groups and resources per handle", () => {
    const scm = createMainThreadScm();
    expect(scm.handle("scm.create", ["h1", "git", "Git", "/repo"])).toBe(true);
    expect(scm.providers.get("h1")).toMatchObject({
      handle: "h1",
      id: "git",
      label: "Git",
      rootPath: "/repo",
      inputValue: "",
      inputPlaceholder: "",
    });

    scm.handle("scm.inputBox", ["h1", { value: "fix: bug", placeholder: "Message" }]);
    expect(scm.providers.get("h1")).toMatchObject({
      inputValue: "fix: bug",
      inputPlaceholder: "Message",
    });
    scm.handle("scm.acceptInputCommand", ["h1", { command: "git.commit", title: "Commit" }]);
    expect(scm.providers.get("h1")?.acceptInputCommand).toEqual({
      command: "git.commit",
      title: "Commit",
    });

    scm.handle("scm.createGroup", ["h1", "changes", "Changes"]);
    scm.handle("scm.setResources", ["h1", "changes", ["a.ts", "b.ts"]]);
    expect(scm.providers.get("h1")?.groups.get("changes")).toEqual({
      id: "changes",
      label: "Changes",
      resources: ["a.ts", "b.ts"],
    });

    scm.handle("scm.disposeGroup", ["h1", "changes"]);
    expect(scm.providers.get("h1")?.groups.has("changes")).toBe(false);
    scm.handle("scm.dispose", ["h1"]);
    expect(scm.providers.has("h1")).toBe(false);
  });

  it("replaces a handle on re-create and ignores operations for unknown handles", () => {
    const scm = createMainThreadScm();
    scm.handle("scm.create", ["h1", "git", "Git"]);
    scm.handle("scm.create", ["h1", "git2", "Git 2"]);
    expect(scm.providers.get("h1")).toMatchObject({ id: "git2", label: "Git 2" });

    expect(scm.handle("scm.inputBox", ["missing", { value: "x" }])).toBe(true);
    expect(scm.handle("scm.setResources", ["missing", "g", ["a"]])).toBe(true);
    expect(scm.handle("scm.dispose", ["missing"])).toBe(true);
    expect(scm.handle("unknown.method", [])).toBe(false);
  });
});

describe("main thread tree views", () => {
  it("registers, refreshes and unregisters a view by revision", () => {
    const tree = createMainThreadTree();
    tree.handle("tree.register", ["view.one"]);
    expect(tree.views.get("view.one")).toEqual({
      viewId: "view.one",
      revision: 0,
      focusRevision: 0,
    });

    tree.handle("tree.refresh", ["view.one"]);
    tree.handle("tree.refresh", ["view.one"]);
    expect(tree.views.get("view.one")?.revision).toBe(2);

    tree.handle("tree.refresh", ["missing"]);
    tree.handle("tree.register", ["view.one"]);
    expect(tree.views.get("view.one")?.revision).toBe(0);

    tree.handle("tree.unregister", ["view.one"]);
    expect(tree.views.has("view.one")).toBe(false);
    tree.handle("tree.unregister", ["view.one"]);
  });
});

describe("main thread webviews", () => {
  it("stores html, queues messages and removes disposed panels", () => {
    const webview = createMainThreadWebview();
    webview.handle("webview.create", ["w1", "demo.view", "Demo"]);
    expect(webview.panels.get("w1")).toMatchObject({
      id: "w1",
      viewType: "demo.view",
      title: "Demo",
      html: "",
      outbox: [],
    });

    webview.handle("webview.setHtml", ["w1", "<h1>hello</h1>"]);
    webview.handle("webview.postMessage", ["w1", { ready: true }]);
    webview.handle("webview.postMessage", ["w1", { ready: false }]);
    expect(webview.panels.get("w1")?.html).toBe("<h1>hello</h1>");
    expect(webview.panels.get("w1")?.outbox).toEqual([{ ready: true }, { ready: false }]);

    webview.handle("webview.setHtml", ["missing", "<p>x</p>"]);
    webview.handle("webview.postMessage", ["missing", 1]);
    expect(webview.panels.size).toBe(1);

    webview.handle("webview.dispose", ["w1"]);
    expect(webview.panels.has("w1")).toBe(false);
  });
});

describe("main thread file decorations", () => {
  it("queries each provider in registration order and unregisters cleanly", async () => {
    const calls: Array<{ sessionId: string; command: string; args: unknown[] }> = [];
    const executeCommand = async (sessionId: string, command: string, args: unknown[]) => {
      calls.push({ sessionId, command, args });
      if (command === "__fileDeco.provide.empty") return undefined;
      return { badge: "M", tooltip: `changed:${String(args[0])}` };
    };
    const decorations = createMainThreadFileDecorations(executeCommand);

    decorations.handle("s1", "window.registerFileDecorationProvider", ["empty"]);
    decorations.handle("s1", "window.registerFileDecorationProvider", ["marked"]);
    expect(await decorations.getDecoration("/repo/a.ts")).toEqual({
      badge: "M",
      tooltip: "changed:/repo/a.ts",
    });
    expect(calls).toEqual([
      { sessionId: "s1", command: "__fileDeco.provide.empty", args: ["/repo/a.ts"] },
      { sessionId: "s1", command: "__fileDeco.provide.marked", args: ["/repo/a.ts"] },
    ]);

    decorations.handle("s1", "window.unregisterFileDecorationProvider", ["empty"]);
    calls.length = 0;
    expect(await decorations.getDecoration("/repo/a.ts")).toEqual({
      badge: "M",
      tooltip: "changed:/repo/a.ts",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("__fileDeco.provide.marked");

    decorations.handle("s1", "window.unregisterFileDecorationProvider", ["marked"]);
    expect(await decorations.getDecoration("/repo/a.ts")).toBeUndefined();
    expect(decorations.handle("s1", "other", [])).toBe(false);
  });
});
