import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createMainThreadWorkspace } from "../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type WorkspaceNodeModule = typeof import("../../packages/ui-workspace/src/node.ts");
type StorageModule = typeof import("../../packages/ui-storage/src/storage.ts");
type ConfigModule = typeof import("../../packages/ui-config/src/index.ts");
let modules: HarnessModules;
let di: DiModule;
let workspaceNode: WorkspaceNodeModule;
let storage: StorageModule;
let configuration: ConfigModule;
let temp: string;

beforeAll(async () => {
  modules = await createHarnessModules();
  [di, workspaceNode, storage, configuration] = await Promise.all([
    modules.load<DiModule>("/packages/di/src/index.ts"),
    modules.load<WorkspaceNodeModule>("/packages/ui-workspace/src/node.ts"),
    modules.load<StorageModule>("/packages/ui-storage/src/storage.ts"),
    modules.load<ConfigModule>("/packages/ui-config/src/index.ts"),
  ]);
  temp = mkdtempSync(join(tmpdir(), "harness-workspace-alignment-"));
});
afterAll(async () => {
  rmSync(temp, { recursive: true, force: true });
  await modules.close();
});

const source = `
const vscode = require("vscode");
exports.activate = (context) => {
  let document;
  const events = [];
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.ts", false, true, false);
  context.subscriptions.push(watcher,
    watcher.onDidCreate(uri => events.push(["create", uri.fsPath])),
    watcher.onDidChange(uri => events.push(["fileChange", uri.fsPath])),
    watcher.onDidDelete(uri => events.push(["delete", uri.fsPath])),
    vscode.workspace.onDidOpenTextDocument(doc => events.push(["open", doc.uri.fsPath])),
    vscode.workspace.onDidCloseTextDocument(doc => events.push(["close", doc === document, doc.isClosed])),
    vscode.workspace.onDidSaveTextDocument(doc => events.push(["save", doc === document, doc.isDirty])),
    vscode.workspace.onDidChangeTextDocument(event => events.push(["change", event.document === document, event.contentChanges.map(change => ({
      text: change.text, offset: change.rangeOffset, length: change.rangeLength,
      range: change.range instanceof vscode.Range,
    }))])),
  );
  vscode.commands.registerCommand("alignment.open", async root => {
    document = await vscode.workspace.openTextDocument(root + "/src/doc.ts");
    return {
      same: document === await vscode.workspace.openTextDocument(vscode.Uri.file(root + "/src/doc.ts")),
      cached: document === vscode.workspace.textDocuments[0],
      text: document.getText(new vscode.Range(0, 2, 1, 2)),
      offset: document.offsetAt(new vscode.Position(1, 2)),
      newline: [document.positionAt(3).line, document.positionAt(3).character],
      line: document.lineAt(new vscode.Position(1, 0)),
      bounded: document.validatePosition(new vscode.Position(99, 99)),
      relative: vscode.workspace.asRelativePath(document.uri),
    };
  });
  vscode.commands.registerCommand("alignment.search", async root => {
    const hits = [];
    const search = await vscode.workspace.findTextInFiles({ pattern: "alpha" }, { include: "**/*.txt", maxResults: 2 }, hit => hits.push({
      text: hit.preview.text,
      range: [hit.ranges.start.line, hit.ranges.start.character, hit.ranges.end.character],
      preview: [hit.preview.matches.start.line, hit.preview.matches.start.character, hit.preview.matches.end.character],
    }));
    const paths = values => values.map(uri => vscode.workspace.asRelativePath(uri)).sort();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(vscode.Uri.file(root + "/created.ts"));
    return {
      all: paths(await vscode.workspace.findFiles("**/*.{ts,txt}")),
      includingExcluded: paths(await vscode.workspace.findFiles("**/*.ts", null)),
      relative: paths(await vscode.workspace.findFiles(new vscode.RelativePattern(root + "/src", "**/*.ts"))),
      canceled: await vscode.workspace.findFiles("**/*", undefined, undefined, cancellation.token),
      bytes: [...await vscode.workspace.fs.readFile(vscode.Uri.file(root + "/bytes.bin"))],
      hits, limitHit: search.limitHit, fileEditApplied: await vscode.workspace.applyEdit(edit),
    };
  });
  vscode.commands.registerCommand("alignment.fileSearchOptions", async root => {
    const paths = values => values.map(uri => vscode.workspace.asRelativePath(uri)).sort();
    const { findFiles, findFiles2 } = vscode.workspace;
    const { FilesExclude, None } = vscode.ExcludeSettingOptions;
    const patterns = ["**/*.ts", new vscode.RelativePattern(root + "/src", "*.txt"), "**/doc.ts"];
    return {
      defaults: paths(await findFiles2(patterns)),
      filesExclude: paths(await findFiles2(patterns, { useExcludeSettings: FilesExclude })),
      explicitWithSettings: paths(await findFiles2(patterns, { exclude: ["**/doc.ts"] })),
      caseInsensitive: paths(await findFiles2(patterns, {
        useExcludeSettings: None,
        caseInsensitive: true,
        exclude: [new vscode.RelativePattern(root + "/excluded", "*.ts"), "**/DOC.TS"],
      })),
      legacyExplicit: paths(await findFiles("**/*.ts", "**/nested")),
    };
  });
  vscode.commands.registerCommand("alignment.fileSearchLimit", async () => {
    const paths = values => values.map(uri => vscode.workspace.asRelativePath(uri));
    const { findFiles2 } = vscode.workspace;
    return {
      limited: paths(await findFiles2(["*.txt", "search.txt"], { maxResults: 1 })),
      zero: paths(await findFiles2(["**/*"], { maxResults: 0 })),
      empty: paths(await findFiles2([])),
    };
  });
  vscode.commands.registerCommand("alignment.fileSearchEngine", async () => {
    const { findFiles, findFiles2 } = vscode.workspace;
    const names = values => values.map(uri => vscode.workspace.asRelativePath(uri)).sort();
    const patterns = ["**/*-scope.md"];
    const cancellation = new vscode.CancellationTokenSource();
    const pending = findFiles2(["bulk/*.candidate"], {}, cancellation.token);
    setImmediate(() => cancellation.cancel());
    const canceled = await pending;
    cancellation.dispose();
    return {
      defaults: names(await findFiles2(patterns)),
      parent: names(await findFiles2(patterns, { useIgnoreFiles: { parent: true } })),
      unfiltered: names(await findFiles2(patterns, {
        useIgnoreFiles: { local: false },
        followSymlinks: false,
      })),
      legacy: names(await findFiles("**/*-scope.md")),
      count: (await findFiles2(["bulk/*.candidate"])).length,
      canceled: names(canceled),
    };
  });
  vscode.commands.registerCommand("alignment.state", () => ({
    text: document.getText(), version: document.version, dirty: document.isDirty, closed: document.isClosed,
    documents: vscode.workspace.textDocuments.length, events,
    folders: vscode.workspace.workspaceFolders?.map(folder => ({ path: folder.uri.fsPath, index: folder.index })),
  }));
  vscode.commands.registerCommand("alignment.disposeWatcher", () => watcher.dispose());
  const virtualUri = vscode.Uri.parse("alignment-content:/preview?document=1");
  vscode.commands.registerCommand("alignment.virtualLifecycle", async () => {
    const changes = new vscode.EventEmitter();
    let text = "initial";
    const registration = vscode.workspace.registerTextDocumentContentProvider(virtualUri.scheme, {
      onDidChange: changes.event,
      provideTextDocumentContent: () => text,
    });
    const virtual = await vscode.workspace.openTextDocument(virtualUri);
    const closed = [];
    const listener = vscode.workspace.onDidCloseTextDocument(doc => closed.push(doc === virtual));
    let finishOld, finishCurrent, finishLate;
    text = new Promise(resolve => { finishOld = resolve; });
    changes.fire(virtualUri);
    text = new Promise(resolve => { finishCurrent = resolve; });
    changes.fire(virtualUri);
    finishOld("old");
    await new Promise(setImmediate);
    const interim = virtual.getText();
    finishCurrent("current");
    await new Promise(setImmediate);
    const current = virtual.getText();
    const version = virtual.version;
    const saved = await virtual.save();

    text = new Promise(resolve => { finishLate = resolve; });
    changes.fire(virtualUri);
    const pending = vscode.workspace.openTextDocument(virtualUri.with({ query: "other" }));
    registration.dispose();
    finishLate("late");
    const pendingError = await pending.catch(error => error.code);
    changes.dispose();
    listener.dispose();

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(virtualUri.scheme, {
      provideTextDocumentContent: () => "replacement",
    }));
    const replacement = await vscode.workspace.openTextDocument(virtualUri);
    return {
      interim, current, version, saved, pendingError, closed,
      oldText: virtual.getText(),
      oldClosed: virtual.isClosed,
      same: replacement === virtual,
      replacement: replacement.getText(),
    };
  });
  vscode.commands.registerCommand("alignment.virtualState", async () => {
    const current = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === virtualUri.toString());
    return { text: current?.getText(), same: current === await vscode.workspace.openTextDocument(virtualUri) };
  });
};
`;

describe("workspace editor API across the extension child process", () => {
  it("preserves CRLF document identity and lifecycle while searching real files and forwarding watcher events", async () => {
    const root = join(temp, "workspace");
    const extension = join(temp, "extensions", "alignment");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "excluded"));
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(root, "src/doc.ts"), "ab\r\n  cd\r\n");
    writeFileSync(join(root, "src/nested/more.ts"), "export {};");
    writeFileSync(join(root, "excluded/hidden.ts"), "hidden");
    writeFileSync(join(root, "search.txt"), "alpha alpha\nalpha\n");
    writeFileSync(join(root, "bytes.bin"), Buffer.from([0, 255, 1, 128]));
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "alignment",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onStartup"],
      }),
    );
    writeFileSync(join(extension, "extension.cjs"), source);
    const scope = di.createRootScope();
    scope.provideAll([
      storage.UiStorageService,
      configuration.UiConfigService,
      workspaceNode.WorkspaceFsService,
    ]);
    const fs = scope.get(workspaceNode.WorkspaceFsService);
    const config = scope.get(configuration.UiConfigService);
    config.set("files.exclude", { "**/excluded/**": true }, "workspace");
    const directoryReads: string[] = [];
    const workspace = {
      activeRoots: { value: [root] },
      getRoot: () => ({
        readFile: (relative: string) => fs.readFile(root, relative),
        loadDir: (relative: string) => {
          directoryReads.push(relative);
          return fs.readDir(root, relative);
        },
      }),
    };
    const handleMain = createMainThreadWorkspace(workspace as never, config);
    const hostFixture = await createExtensionHostFixture();
    const host = hostFixture.service;
    const off = host.onMainThreadCall(async (_session, method, args, id) => {
      try {
        host.resolveMainCall(id, await handleMain(method, args));
      } catch (error) {
        host.resolveMainCall(id, undefined, String(error));
      }
    });
    const session = "workspace-alignment";
    try {
      await host.scanExtensions(join(temp, "extensions"));
      await host.startSession(session, [root], { configuration: config.snapshot() });
      await host.activateByEvent(session, "onStartup");
      const opened = await host.executeCommand<Record<string, unknown>>(
        session,
        "alignment.open",
        root,
      );
      expect(opened).toMatchObject({
        same: true,
        cached: true,
        text: "\r\n  ",
        offset: 6,
        newline: [0, 2],
        relative: "src/doc.ts",
        line: { text: "  cd", firstNonWhitespaceCharacterIndex: 2 },
        bounded: { line: 2, character: 0 },
      });
      expect(await host.executeCommand(session, "alignment.search", root)).toEqual({
        all: ["search.txt", "src/doc.ts", "src/nested/more.ts"],
        includingExcluded: ["excluded/hidden.ts", "src/doc.ts", "src/nested/more.ts"],
        relative: ["src/doc.ts", "src/nested/more.ts"],
        canceled: [],
        bytes: [0, 255, 1, 128],
        fileEditApplied: true,
        hits: [
          { text: "alpha alpha", range: [0, 0, 5], preview: [0, 0, 5] },
          { text: "alpha alpha", range: [0, 6, 11], preview: [0, 6, 11] },
        ],
        limitHit: true,
      });
      writeFileSync(join(root, "src/guide.TXT"), "Guide");
      config.set("search.exclude", { "**/nested": true, "**/excluded/**": false }, "workspace");
      await host.executeCommand(session, "__config.sync", config.snapshot());
      expect(await host.executeCommand(session, "alignment.fileSearchOptions", root)).toEqual({
        defaults: ["excluded/hidden.ts", "src/doc.ts"],
        filesExclude: ["src/doc.ts", "src/nested/more.ts"],
        explicitWithSettings: ["excluded/hidden.ts"],
        caseInsensitive: ["src/guide.TXT", "src/nested/more.ts"],
        legacyExplicit: ["src/doc.ts"],
      });
      directoryReads.length = 0;
      expect(await host.executeCommand(session, "alignment.fileSearchLimit")).toEqual({
        limited: ["search.txt"],
        zero: [],
        empty: [],
      });
      expect(directoryReads).toEqual([]);

      writeFileSync(join(temp, ".ignore"), "parent-scope.md\n");
      writeFileSync(join(root, ".gitignore"), "local-scope.md\n");
      writeFileSync(join(root, "src/.ignore"), "nested-scope.md\n");
      writeFileSync(join(root, "local-scope.md"), "");
      writeFileSync(join(root, "parent-scope.md"), "");
      writeFileSync(join(root, "src/nested-scope.md"), "");
      writeFileSync(join(root, "src/visible-scope.md"), "");
      const linkTarget = join(temp, "file-search-link-target");
      mkdirSync(linkTarget);
      writeFileSync(join(linkTarget, "linked-scope.md"), "");
      symlinkSync(linkTarget, join(root, "linked"), "junction");
      mkdirSync(join(root, "bulk"));
      for (let index = 0; index < 2005; index++)
        writeFileSync(join(root, "bulk", `${index}.candidate`), "");
      expect(await host.executeCommand(session, "alignment.fileSearchEngine")).toEqual({
        defaults: ["linked/linked-scope.md", "parent-scope.md", "src/visible-scope.md"],
        parent: ["linked/linked-scope.md", "src/visible-scope.md"],
        unfiltered: [
          "local-scope.md",
          "parent-scope.md",
          "src/nested-scope.md",
          "src/visible-scope.md",
        ],
        legacy: [
          "linked/linked-scope.md",
          "local-scope.md",
          "parent-scope.md",
          "src/nested-scope.md",
          "src/visible-scope.md",
        ],
        count: 2005,
        canceled: [],
      });
      const uri = { scheme: "file", path: join(root, "src/doc.ts") };
      const snapshot = {
        uri,
        text: "updated\r\n",
        version: 2,
        languageId: "typescript",
        eol: 2,
        isDirty: true,
      };
      await host.executeCommand(session, "__ws.onDidChangeTextDocument", {
        document: snapshot,
        contentChanges: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
            rangeOffset: 0,
            rangeLength: 10,
            text: snapshot.text,
          },
        ],
      });
      await host.executeCommand(session, "__win.onDidChangeActiveTextEditor", {
        document: { ...snapshot, text: "stale", version: 1 },
        selections: [],
        visibleRanges: [],
        options: {},
      });
      expect(await host.executeCommand(session, "alignment.state")).toMatchObject({
        text: "updated\r\n",
        version: 2,
        dirty: true,
      });
      await host.executeCommand(session, "__ws.onDidSaveTextDocument", {
        ...snapshot,
        isDirty: false,
      });
      for (const type of ["add", "change", "unlink"]) {
        await host.executeCommand(session, "__ws.fileChanged", {
          root,
          path: uri.path,
          relativePath: "src/doc.ts",
          type,
        });
      }
      await host.executeCommand(session, "alignment.disposeWatcher");
      await host.executeCommand(session, "__ws.fileChanged", {
        root,
        path: uri.path,
        relativePath: "src/doc.ts",
        type: "add",
      });
      await host.executeCommand(session, "__ws.onDidCloseTextDocument", {
        ...snapshot,
        isDirty: false,
      });
      const state = await host.executeCommand<Record<string, unknown>>(session, "alignment.state");
      expect(state).toMatchObject({
        text: "updated\r\n",
        version: 2,
        dirty: false,
        closed: true,
        documents: 0,
      });
      expect(state.events).toEqual([
        ["open", uri.path],
        ["change", true, [{ text: snapshot.text, offset: 0, length: 10, range: true }]],
        ["save", true, false],
        ["create", uri.path],
        ["delete", uri.path],
        ["close", true, true],
      ]);
      await host.executeCommand(session, "__ws.onDidChangeWorkspaceFolders", {
        added: [],
        removed: [{ uri: { scheme: "file", path: root }, name: "workspace", index: 0 }],
      });
      expect(await host.executeCommand(session, "alignment.state")).not.toHaveProperty("folders");
      expect(await host.executeCommand(session, "alignment.virtualLifecycle")).toEqual({
        interim: "initial",
        current: "current",
        version: 2,
        saved: false,
        pendingError: "Unavailable",
        closed: [true],
        oldText: "current",
        oldClosed: true,
        same: false,
        replacement: "replacement",
      });
      await host.executeCommand(session, "__ws.syncDocuments", []);
      expect(await host.executeCommand(session, "alignment.virtualState")).toEqual({
        text: "replacement",
        same: true,
      });
    } finally {
      await hostFixture.dispose(session);
      off();
      scope.dispose();
    }
  });
});
