import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { createMainThreadFileDecorations } from "../../packages/vscode-ext-host/src/main-thread/file-decorations.ts";
import { createMainThreadScm } from "../../packages/vscode-ext-host/src/main-thread/scm.ts";
import { createMainThreadMemento } from "../../packages/vscode-ext-host/src/main-thread/memento.ts";
import { createMainThreadWorkspace } from "../../packages/vscode-ext-host/src/main-thread/workspace.ts";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";
import { createMainThreadTerminal } from "../../packages/vscode-ext-host/src/main-thread/terminal.ts";
import { createMainThreadCommands } from "../../packages/vscode-ext-host/src/main-thread/commands.ts";
import { TerminalService, type CreateTerminalOptions } from "../../packages/terminal/src/index.ts";
import { TextDocumentData, Uri } from "../../packages/vscode-types/src/index.ts";

const builtinDirectory =
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
const available = existsSync(join(builtinDirectory, "git", "package.json"));
type Provider = Record<string, (...args: unknown[]) => unknown>;

const probeSource = String.raw`
const vscode = require("vscode");
exports.activate = (context) => {
  const notebookEvents = [];
  context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(document => notebookEvents.push(["open", document.uri.fsPath])), vscode.workspace.onDidCloseNotebookDocument(document => notebookEvents.push(["close", document.isClosed])), vscode.workspace.onDidChangeNotebookDocument(event => notebookEvents.push(["change", event.cellChanges.length, event.contentChanges.length])), vscode.workspace.onDidSaveNotebookDocument(document => notebookEvents.push(["save", document.isDirty])));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.notebook.probe", async (root, operation) => {
    const document = await vscode.workspace.openNotebookDocument(vscode.Uri.file(root + "/fixture.ipynb"));
    let saved;
    if (operation === "modify") {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.cellAt(0).document.uri, new vscode.Range(0, 0, 0, 14), "print('changed')");
      edit.set(document.uri, [vscode.NotebookEdit.insertCells(document.cellCount, [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "# inserted", "markdown")])]);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error("Notebook edit failed");
      const api = (await vscode.extensions.getExtension("vscode.ipynb").activate());
      if (!await api.setNotebookMetadata(document.uri, { harnessFixture: "persisted" })) throw new Error("Notebook metadata edit failed");
      saved = await document.save();
    }
    return { type: document.notebookType, count: document.cellCount, dirty: document.isDirty, saved, metadata: document.metadata, cells: document.getCells().map(cell => ({ kind: cell.kind, text: cell.document.getText(), language: cell.document.languageId, output: cell.outputs.flatMap(output => output.items.map(item => ({ mime: item.mime, text: new TextDecoder().decode(item.data) }))) })), events: notebookEvents };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.workspace.providers", async root => {
    const uri = vscode.Uri.parse("fixture-content:/note");
    const changes = new vscode.EventEmitter();
    let text = "first";
    const content = vscode.workspace.registerTextDocumentContentProvider(uri.scheme, { onDidChange: changes.event, provideTextDocumentContent: value => { if (value.toString() !== uri.toString()) throw new Error("Wrong content URI"); return text; } });
    context.subscriptions.push(content, changes);
    const document = await vscode.workspace.openTextDocument(uri);
    const update = new Promise(resolve => {
      const listener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document) return;
        listener.dispose(); resolve({ same: event.document === document, version: document.version, text: document.getText(), change: event.contentChanges[0].text });
      });
    });
    text = "second"; changes.fire(uri);
    const updated = await update;
    const binary = vscode.Uri.file(root + "/binary.bin");
    await vscode.workspace.fs.writeFile(binary, Uint8Array.from([0, 255, 128, 1]));
    const bytes = [...await vscode.workspace.fs.readFile(binary)];
    const events = [];
    const listeners = [
      vscode.workspace.onWillRenameFiles(event => { events.push("willRename"); event.waitUntil(Promise.resolve(undefined)); }),
      vscode.workspace.onDidRenameFiles(event => events.push(["renamed", event.files[0].oldUri.fsPath, event.files[0].newUri.fsPath])),
      vscode.workspace.onDidCreateFiles(event => events.push(["created", event.files[0].fsPath])),
      vscode.workspace.onDidDeleteFiles(event => events.push(["deleted", event.files[0].fsPath])),
    ];
    const raw = vscode.Uri.file(root + "/binary-renamed.bin");
    await vscode.workspace.fs.rename(binary, raw);
    if (events.length) throw new Error("Raw filesystem changes must not emit file operation events");
    const created = vscode.Uri.file(root + "/created.txt"), renamed = vscode.Uri.file(root + "/renamed.txt");
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(created, { contents: Uint8Array.from([65, 66]) });
    edit.replace(created, new vscode.Range(0, 0, 0, 1), "first");
    edit.replace(created, new vscode.Range(0, 1, 0, 2), "second");
    edit.renameFile(created, renamed);
    edit.insert(renamed, new vscode.Position(0, 0), "renamed: ");
    const applied = await vscode.workspace.applyEdit(edit);
    const editedText = new TextDecoder().decode(await vscode.workspace.fs.readFile(renamed));
    const deletion = new vscode.WorkspaceEdit(); deletion.deleteFile(renamed);
    if (!await vscode.workspace.applyEdit(deletion)) throw new Error("Delete edit failed");
    for (const listener of listeners) listener.dispose();
    let missing;
    try { await vscode.workspace.fs.stat(renamed); } catch(error) { missing = error.code; }
    let prepared = false;
    context.subscriptions.push(vscode.workspace.onWillCreateEditSessionIdentity(event => event.waitUntil(Promise.resolve().then(() => { prepared = true; }))));
    context.subscriptions.push(vscode.workspace.registerEditSessionIdentityProvider("file", { provideEditSessionIdentity: folder => prepared ? folder.uri.fsPath + ":identity" : "incorrect" }));
    context.subscriptions.push(vscode.workspace.registerTimelineProvider("fixture", "Fixture", ["file"], { provideTimeline: value => ({ source: "fixture", items: [{ id: "entry", label: value.path, timestamp: 1 }] }) }));
    const fileChanges = new vscode.EventEmitter();
    let watches = 0;
    const watched = [];
    const pendingWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse("fixture-fs:/"), "**"));
    context.subscriptions.push(pendingWatcher, pendingWatcher.onDidChange(uri => watched.push(uri.toString())));
    const memory = new Map([["/bytes", Uint8Array.from([0, 254])]]);
    const fsRegistration = vscode.workspace.registerFileSystemProvider("fixture-fs", {
      onDidChangeFile: fileChanges.event, watch: () => { watches++; return new vscode.Disposable(() => { watches--; }); },
      stat: value => { const data = memory.get(value.path); if (!data) throw vscode.FileSystemError.FileNotFound(value); return { type: 1, ctime: 0, mtime: 0, size: data.length }; },
      readFile: value => { const data = memory.get(value.path); if (!data) throw vscode.FileSystemError.FileNotFound(value); return data; },
      readDirectory: () => [...memory].map(([name]) => [name.slice(1), 1]),
      writeFile: (value, data) => { memory.set(value.path, data); fileChanges.fire([{ type: 1, uri: value }]); },
      createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
      delete: value => memory.delete(value.path),
      rename: (from, to) => { memory.set(to.path, memory.get(from.path)); memory.delete(from.path); },
    });
    context.subscriptions.push(fsRegistration, fileChanges);
    const remote = vscode.Uri.parse("fixture-fs:/bytes");
    const remoteBytes = [...await vscode.workspace.fs.readFile(remote)];
    const remoteDocument = await vscode.workspace.openTextDocument(remote);
    const remoteUpdate = new Promise(resolve => {
      const listener = vscode.workspace.onDidChangeTextDocument(event => { if (event.document === remoteDocument) { listener.dispose(); resolve(remoteDocument.getText()); } });
    });
    await vscode.workspace.fs.writeFile(remote, new TextEncoder().encode("updated"));
    const remoteText = await remoteUpdate;
    const watchStarted = watches;
    pendingWatcher.dispose();
    return { updated, bytes, remoteBytes, remoteText, applied, editedText, events, missing, watched, watchStarted, watchStopped: watches };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.terminal.environment", root => {
    const env = context.environmentVariableCollection;
    env.replace("HARNESS_TEST_ENV", "base");
    env.getScoped({ workspaceFolder: vscode.workspace.workspaceFolders[0] }).append("HARNESS_TEST_ENV", ":scoped");
    for (const cwd of [root, require("node:path").dirname(root)]) {
      context.subscriptions.push(vscode.window.createTerminal({ name: cwd, cwd, shellPath: "/bin/sh", shellArgs: ["-c", 'printf "RESULT=%s|" "$HARNESS_TEST_ENV"; printenv HARNESS_TEST_REMOVED || printf "unset\\n"'], env: { HARNESS_TEST_REMOVED: null } }));
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.git.probe", async (root, operation) => {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension) throw new Error("Official vscode.git extension is missing");
    const git = await extension.activate();
    if (!git.enabled) throw new Error("Official Git extension did not enable its Git model");
    const api = git.getAPI(1);
    const repository = await api.openRepository(vscode.Uri.file(root));
    if (!repository) throw new Error("Official Git extension did not open the repository");
    if (operation === "stage") await repository.add([root + "/tracked.txt", root + "/untracked.txt"]);
    if (operation === "unstage") await repository.revert([root + "/tracked.txt", root + "/untracked.txt"]);
    await repository.status();
    const headUri = vscode.Uri.file(root + "/tracked.txt").with({ scheme: "git", query: JSON.stringify({ path: root + "/tracked.txt", ref: "HEAD" }) });
    const headContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(headUri));
    const headDocument = await vscode.workspace.openTextDocument(headUri);
    const describe = change => ({ path: change.uri.fsPath, status: change.status });
    return {
      enabled: git.enabled, root: repository.rootUri.fsPath,
      head: repository.state.HEAD?.name,
      working: repository.state.workingTreeChanges.map(describe),
      index: repository.state.indexChanges.map(describe),
      untracked: repository.state.untrackedChanges.map(describe),
      repositories: api.repositories.map(item => item.rootUri.fsPath),
      headContent, headDocument: headDocument.getText(),
    };
  }));
  let sourceControl;
  const scmEvents = [];
  context.subscriptions.push(vscode.commands.registerCommand("builtin.scm.create", () => {
    sourceControl = vscode.scm.createSourceControl("fixture", "Fixture", vscode.Uri.file("/fixture"));
    context.subscriptions.push(sourceControl, sourceControl.onDidChangeSelection(value => scmEvents.push(["selected", value])), sourceControl.inputBox.onDidChange(value => scmEvents.push(["input", value])));
    const accept = vscode.commands.registerCommand("builtin.scm.accept", source => source === sourceControl);
    context.subscriptions.push(accept);
    sourceControl.acceptInputCommand = { command: "builtin.scm.accept", title: "Accept", arguments: [sourceControl] };
    sourceControl.count = 1;
    sourceControl.commitTemplate = "template";
    sourceControl.inputBox.value = "initial";
    sourceControl.inputBox.enabled = false;
    sourceControl.inputBox.visible = true;
    const group = sourceControl.createResourceGroup("changes", "Changes");
    group.hideWhenEmpty = true;
    group.resourceStates = [{ resourceUri: vscode.Uri.file("/fixture/file.txt"), decorations: { tooltip: "Modified", strikeThrough: true }, command: { command: "builtin.scm.accept", title: "Inspect", arguments: [sourceControl] } }];
  }));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.scm.state", () => ({
    selected: sourceControl.selected, input: sourceControl.inputBox.value, text: sourceControl.inputBox.document.getText(), events: scmEvents,
  })));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.scm.parent", () => {
    const parent = vscode.scm.createSourceControl("parent", "Parent");
    const child = vscode.scm.createSourceControl("child", "Child", undefined, new vscode.ThemeIcon("repo"), parent);
    let disposed = 0;
    child.onDidDisposeParent(() => disposed++);
    child.contextValue = "nested"; child.activeRepositoryName = "child repository";
    parent.dispose(); parent.dispose();
    context.subscriptions.push(child);
    return disposed;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("builtin.gitBase.probe", async () => {
    const extension = vscode.extensions.getExtension("vscode.git-base");
    const api = (await extension.activate()).getAPI(1);
    const registration = api.registerRemoteSourceProvider({
      name: "fixture", icon: "repo", supportsQuery: false,
      getRemoteSources: async () => [],
      getRemoteSourceActions: async url => url === "https://example.invalid/repository" ? [{ label: "Inspect", run: () => "inspected" }] : [],
    });
    try { return { active: extension.isActive, actions: (await api.getRemoteSourceActions("https://example.invalid/repository")).map(action => action.label) }; }
    finally { registration.dispose(); }
  }));
};
`;

async function createBuiltinFixture(
  includeGit: boolean | null,
  fileTextBackend = false,
  additionalBuiltins: string[] = [],
) {
  const artifacts = join(process.cwd(), "temp/artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-git-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const name of [
    ...(includeGit === null ? [] : includeGit ? ["git-base", "git"] : ["git-base"]),
    ...additionalBuiltins,
  ])
    cpSync(join(builtinDirectory, name), join(extensions, name), { recursive: true });
  const probe = join(extensions, "probe");
  mkdirSync(probe);
  writeFileSync(
    join(probe, "package.json"),
    JSON.stringify({
      name: "builtin-probe",
      publisher: "harness",
      version: "1.0.0",
      main: "./extension.cjs",
      activationEvents: [
        "onCommand:builtin.git.probe",
        "onCommand:builtin.gitBase.probe",
        "onCommand:builtin.scm.create",
        "onCommand:builtin.workspace.providers",
        "onCommand:builtin.terminal.environment",
        "onCommand:builtin.notebook.probe",
      ],
    }),
  );
  writeFileSync(join(probe, "extension.cjs"), probeSource);
  const repository = join(root, "repository");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Harness Builtin Fixture");
  git("config", "user.email", "builtin-fixture@example.invalid");
  writeFileSync(join(repository, "tracked.txt"), "original\n");
  git("add", "tracked.txt");
  git("commit", "-m", "fixture initial commit", "--no-verify");
  writeFileSync(join(repository, "tracked.txt"), "modified\n");
  writeFileSync(join(repository, "untracked.txt"), "new file\n");
  const hostFixture = await createExtensionHostFixture();
  const host = hostFixture.service;
  const modules = await createHarnessModules();
  const [di, storageModule, configModule, workspaceNode] = await Promise.all([
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
    storageModule.UiStorageService,
    configModule.UiConfigService,
    workspaceNode.WorkspaceFsService,
  ]);
  const storage = scope.get(storageModule.UiStorageService);
  const memento = createMainThreadMemento(storage);
  const config = scope.get(configModule.UiConfigService);
  const fs = scope.get(workspaceNode.WorkspaceFsService);
  const workspace = {
    activeRoots: { value: [repository] },
    getRoot: () => ({
      readFile: (relative: string) => fs.readFile(repository, relative),
      loadDir: (relative: string) => fs.readDir(repository, relative, true),
      writeFile: (relative: string, content: string) => fs.writeFile(repository, relative, content),
      createDir: (relative: string) => fs.createDir(repository, relative),
      deletePath: (relative: string) => fs.deletePath(repository, relative),
      renamePath: (from: string, to: string) => fs.renamePath(repository, from, to),
    }),
  };
  const handleWorkspace = createMainThreadWorkspace(
    workspace as never,
    config,
    fileTextBackend
      ? ({
          renameDocument: (_root: string, from: string, to: string) =>
            fs.renamePath(repository, from, to),
          async applyEdit(
            entries: [
              Uri,
              {
                range: {
                  start: { line: number; character: number };
                  end: { line: number; character: number };
                };
                newText: string;
              }[],
            ][],
          ) {
            for (const [uri, edits] of entries) {
              const document = new TextDocumentData({
                uri: uri.toJSON(),
                text: readFileSync(uri.fsPath, "utf8"),
                version: 1,
                languageId: "plaintext",
                eol: 1,
                isDirty: false,
              });
              let text = document.getText();
              for (const edit of [...edits].sort(
                (a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start),
              ))
                text =
                  text.slice(0, document.offsetAt(edit.range.start)) +
                  edit.newText +
                  text.slice(document.offsetAt(edit.range.end));
              writeFileSync(uri.fsPath, text);
            }
            return true;
          },
        } as never)
      : undefined,
  );
  const workspaceMethods = new Set([
    "workspace.getConfig",
    "workspace.updateConfig",
    "workspace.readFile",
    "workspace.readFileBytes",
    "workspace.writeFile",
    "workspace.readDirectory",
    "workspace.createDirectory",
    "workspace.delete",
    "workspace.rename",
    "workspace.openTextDocument",
    "workspace.saveTextDocument",
    "workspace.findTextInFiles",
    "workspace.applyEdit",
  ]);
  const calls: { method: string; args: unknown[] }[] = [];
  const failures: string[] = [];
  const terminals = new TerminalService();
  const terminalRuns: Promise<string>[] = [];
  const handleTerminal = createMainThreadTerminal(
    {
      async create(options: CreateTerminalOptions) {
        const result = Promise.withResolvers<string>();
        terminalRuns.push(result.promise);
        try {
          const terminal = await terminals.create(options);
          let output = "";
          const attachment = terminals.attach(terminal.id, {
            onData(data) {
              output += data;
            },
            onExit(code) {
              attachment?.detach();
              code === 0
                ? result.resolve(output)
                : result.reject(new Error(`Terminal exited: ${code}: ${output}`));
            },
          });
          return terminal;
        } catch (error) {
          result.reject(error);
          throw error;
        }
      },
      kill: (id: string) => terminals.kill(id),
      write: (id: string, text: string) => terminals.write(id, text),
    } as never,
    {} as never,
    (session, command, args) => host.executeCommand(session, command, ...args),
  );
  const results: Record<string, unknown> = {};
  const scm = createMainThreadScm((command, args) => {
    void host
      .executeCommand("builtin-git", command, ...args)
      .catch((error) => failures.push(String(error)));
  });
  const output = new Map<string, { text: string; visible: boolean; disposed: boolean }>();
  const uriHandlers = new Set<string>();
  const progress = new Map<string, unknown>();
  const statusItems = new Map<string, Record<string, unknown>>();
  const decorations = new Map<string, unknown>();
  const fileDecorations = createMainThreadFileDecorations((session, command, args) =>
    host.executeCommand(session, command, ...args),
  );
  const commands = new Set<string>();
  const commandService = createMainThreadCommands({
    has: (command) => commands.has(command),
    execute: (command, ...args) => host.executeCommand("builtin-git", command, ...args),
  });
  const providers = new Map<string, Provider>();
  const diagnostics = new Map<string, Map<string, unknown>>();
  const languages = createMainThreadLanguages(
    {
      ...Object.fromEntries(
        ["FoldingRange", "CompletionItem", "Hover", "CodeActions", "DocumentLink", "CodeLens"].map(
          (kind) => [
            `register${kind}Provider`,
            (_selector: unknown, provider: Provider) => {
              const key = kind === "FoldingRange" ? "folding" : kind;
              providers.set(key, provider);
              return { dispose: () => providers.delete(key) };
            },
          ],
        ),
      ),
      createDiagnosticCollection(name = "") {
        const values = new Map<string, unknown>();
        diagnostics.set(name, values);
        return {
          set(uri: Uri, entries: unknown) {
            if (entries === undefined) values.delete(uri.toString());
            else values.set(uri.toString(), entries);
          },
          clear() {
            values.clear();
          },
          dispose() {
            values.clear();
            diagnostics.delete(name);
          },
        };
      },
    } as never,
    (session, command, args) => host.executeCommand(session, command, ...args),
  );
  const off = host.onMainThreadCall(async (session, method, args, id) => {
    calls.push({ method, args });
    try {
      let result: unknown;
      if (method.startsWith("memento.")) result = memento(session, method, args);
      else if (workspaceMethods.has(method)) {
        result = await handleWorkspace(method, args);
        if (method === "workspace.updateConfig")
          await host.executeCommand(session, "__config.sync", config.snapshot());
      } else if (method.startsWith("terminal.")) {
        if (!(await handleTerminal(session, method, args)))
          throw new Error(`Unimplemented terminal request: ${method}`);
      } else if (scm.handle(method, args)) result = undefined;
      else if (fileDecorations.handle(session, method, args)) result = undefined;
      else if (method === "window.registerUriHandler") uriHandlers.add(String(args[0]));
      else if (method === "window.unregisterUriHandler") uriHandlers.delete(String(args[0]));
      else if (method === "window.progressStart") progress.set(String(args[0]), { title: args[1] });
      else if (method === "window.progressReport")
        progress.set(String(args[0]), { title: args[1], message: args[2] });
      else if (method === "window.progressEnd") progress.delete(String(args[0]));
      else if (method === "statusBar.create")
        statusItems.set(String(args[0]), { alignment: args[1], priority: args[2] });
      else if (method === "statusBar.update") {
        const item = statusItems.get(String(args[0]));
        if (!item) throw new Error(`Unknown status bar item: ${String(args[0])}`);
        Object.assign(item, args[1]);
      } else if (method === "statusBar.dispose") statusItems.delete(String(args[0]));
      else if (method === "window.createDecorationType") decorations.set(String(args[0]), args[1]);
      else if (method === "window.disposeDecorationType") decorations.delete(String(args[0]));
      else if (method === "commands.register") commands.add(String(args[0]));
      else if (method === "commands.unregister") commands.delete(String(args[0]));
      else if (method === "commands.getCommands") result = [...commands];
      else if (method === "commands.execute")
        result = await commandService.execute(String(args[0]), args.slice(1));
      else if (method === "output.create")
        output.set(String(args[0]), { text: "", visible: false, disposed: false });
      else if (method.startsWith("output.")) {
        const channel = output.get(String(args[0]));
        if (!channel) throw new Error(`Unknown output channel: ${String(args[0])}`);
        if (method === "output.append") channel.text += String(args[1]);
        else if (method === "output.appendLine") channel.text += String(args[1]) + "\n";
        else if (method === "output.replace") channel.text = String(args[1]);
        else if (method === "output.clear") channel.text = "";
        else if (method === "output.dispose") channel.disposed = true;
        else if (method === "output.show") channel.visible = true;
        else if (method === "output.hide") channel.visible = false;
        else throw new Error(`Unimplemented output request: ${method}`);
      } else if (method.startsWith("languages.")) languages(session, method, args);
      else if (method === "auth.unregisterSession") result = undefined;
      else throw new Error(`Unimplemented main-thread request: ${method}`);
      if (id) host.resolveMainCall(id, result);
    } catch (error) {
      failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
      if (id) host.resolveMainCall(id, undefined, failures.at(-1));
    }
  });
  config.set("git.autofetch", false);
  config.set("git.openRepositoryInParentFolders", "never");
  config.set("telemetry.telemetryLevel", "off");
  try {
    await host.scanExtensions(extensions);
    await host.startSession("builtin-git", [repository], {
      storageRoot: join(root, "host-storage"),
      configuration: config.snapshot(),
      environment: { language: "en", logLevel: 1 },
    });
  } catch (error) {
    await hostFixture.dispose("builtin-git");
    scope.dispose();
    await modules.close();
    off();
    throw error;
  }
  return {
    host,
    repository,
    root,
    git,
    scm,
    failures,
    calls,
    providers,
    terminalRuns,
    record(key: string, value: unknown) {
      results[key] = value;
    },
    async dispose() {
      await hostFixture.dispose("builtin-git");
      writeFileSync(
        join(root, "main-calls.json"),
        JSON.stringify(
          {
            builtinDirectory,
            results,
            calls,
            failures,
            output: Object.fromEntries(output),
            contextKeys: Object.fromEntries(commandService.contexts),
          },
          null,
          2,
        ),
      );
      off();
      scm.dispose();
      terminals.dispose();
      scope.dispose();
      await modules.close();
    },
  };
}

describe("official VS Code Git builtins", () => {
  it.skipIf(!existsSync(join(builtinDirectory, "ipynb", "package.json")))(
    "serializes, edits, saves and reopens a real notebook with the official ipynb extension",
    { timeout: 60_000 },
    async () => {
      const fixture = await createBuiltinFixture(null, false, ["ipynb"]);
      const notebook = join(fixture.repository, "fixture.ipynb");
      writeFileSync(
        notebook,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
            language_info: { name: "python" },
          },
          cells: [
            {
              cell_type: "code",
              id: "code-cell",
              metadata: {},
              source: ["print('hello')"],
              execution_count: 1,
              outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n"] }],
            },
            { cell_type: "markdown", id: "markdown-cell", metadata: {}, source: ["# initial"] },
          ],
        }),
      );
      try {
        const initial = await fixture.host.executeCommand(
          "builtin-git",
          "builtin.notebook.probe",
          fixture.repository,
          "open",
        );
        expect(initial).toMatchObject({
          type: "jupyter-notebook",
          count: 2,
          dirty: false,
          cells: [
            {
              kind: 2,
              text: "print('hello')",
              language: "python",
              output: [{ mime: "application/vnd.code.notebook.stdout", text: "hello\n" }],
            },
            { kind: 1, text: "# initial" },
          ],
        });
        const saved = await fixture.host.executeCommand(
          "builtin-git",
          "builtin.notebook.probe",
          fixture.repository,
          "modify",
        );
        expect(saved).toMatchObject({
          count: 3,
          saved: true,
          dirty: false,
          cells: [{ text: "print('changed')" }, { text: "# initial" }, { text: "# inserted" }],
        });
        const serialized = JSON.parse(readFileSync(notebook, "utf8"));
        expect(serialized.metadata.harnessFixture).toBe("persisted");
        expect(serialized.cells[0].source.join("")).toBe("print('changed')");
        await fixture.host.executeCommand(
          "builtin-git",
          "__notebooks.close",
          Uri.file(notebook).toJSON(),
        );
        const reopened = await fixture.host.executeCommand(
          "builtin-git",
          "builtin.notebook.probe",
          fixture.repository,
          "open",
        );
        expect(reopened).toMatchObject({
          count: 3,
          dirty: false,
          cells: [
            { text: "print('changed')", output: [{ text: "hello\n" }] },
            { text: "# initial" },
            { text: "# inserted" },
          ],
          events: expect.arrayContaining([
            ["close", true],
            ["save", false],
          ]),
        });
        fixture.record("ipynb", { initial, saved, reopened, serialized });
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.skipIf(!available)(
    "runs Git Base remote actions and its real commit folding provider",
    { timeout: 60_000 },
    async () => {
      const fixture = await createBuiltinFixture(false);
      try {
        const base = await fixture.host.executeCommand("builtin-git", "builtin.gitBase.probe");
        fixture.record("gitBase", base);
        expect(base).toEqual({ active: true, actions: ["Inspect"] });
        const document = new TextDocumentData({
          uri: Uri.file(join(fixture.repository, ".git/COMMIT_EDITMSG")).toJSON(),
          text: "Commit title\n# comment one\n# comment two\n\ndiff --git a/file b/file\n-old\n+new",
          version: 1,
          languageId: "git-commit",
          isDirty: false,
          eol: 1,
        });
        const result = await fixture.providers.get("folding")!.provideFoldingRanges!(
          document,
          {},
          { isCancellationRequested: false },
        );
        fixture.record("commitFolding", result);
        expect(result).toEqual([
          { start: 1, end: 2, kind: 1 },
          { start: 4, end: 6 },
        ]);
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it(
    "round-trips SCM input, selection and commands without serializing extension-owned objects",
    { timeout: 60_000 },
    async () => {
      const fixture = await createBuiltinFixture(null);
      try {
        await fixture.host.executeCommand("builtin-git", "builtin.scm.create");
        const provider = [...fixture.scm.providers.values()].find((item) => item.id === "fixture")!;
        expect(provider).toMatchObject({
          inputValue: "initial",
          inputEnabled: false,
          inputVisible: true,
          count: 1,
          commitTemplate: "template",
        });
        expect(provider.groups.get("changes")).toMatchObject({
          hideWhenEmpty: true,
          resources: [
            {
              resourceUri: { scheme: "file", path: "/fixture/file.txt" },
              decorations: { tooltip: "Modified", strikeThrough: true },
            },
          ],
        });
        expect(
          await fixture.host.executeCommand("builtin-git", provider.acceptInputCommand!.command),
        ).toBe(true);
        provider.inputValue = "from user";
        provider.selected = false;
        expect(await fixture.host.executeCommand("builtin-git", "builtin.scm.state")).toMatchObject(
          {
            selected: false,
            input: "from user",
            text: "from user",
            events: expect.arrayContaining([
              ["input", "from user"],
              ["selected", false],
            ]),
          },
        );
        expect(await fixture.host.executeCommand("builtin-git", "builtin.scm.parent")).toBe(1);
        expect(
          [...fixture.scm.providers.values()].find((provider) => provider.id === "child"),
        ).toMatchObject({
          contextValue: "nested",
          activeRepositoryName: "child repository",
          iconPath: { id: "repo" },
        });
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it(
    "serves binary and virtual documents and emits file operations after actual workspace edits",
    { timeout: 60_000 },
    async () => {
      const fixture = await createBuiltinFixture(null, true);
      try {
        const result = await fixture.host.executeCommand(
          "builtin-git",
          "builtin.workspace.providers",
          fixture.repository,
        );
        expect(result).toEqual({
          updated: { same: true, version: 2, text: "second", change: "second" },
          bytes: [0, 255, 128, 1],
          remoteBytes: [0, 254],
          remoteText: "updated",
          applied: true,
          editedText: "renamed: firstsecond",
          missing: "FileNotFound",
          watched: ["fixture-fs:/bytes"],
          watchStarted: 1,
          watchStopped: 0,
          events: [
            ["created", join(fixture.repository, "created.txt")],
            "willRename",
            [
              "renamed",
              join(fixture.repository, "created.txt"),
              join(fixture.repository, "renamed.txt"),
            ],
            ["deleted", join(fixture.repository, "renamed.txt")],
          ],
        });
        expect(
          fixture.calls
            .filter(
              ({ method }) => method === "workspace.applyEdit" || method === "workspace.rename",
            )
            .map(({ method }) => method),
        ).toEqual(["workspace.applyEdit", "workspace.rename", "workspace.applyEdit"]);
        const uri = Uri.file(fixture.repository).toJSON();
        expect(
          await fixture.host.executeCommand("builtin-git", "__ws.provideEditSessionIdentity", {
            uri,
            name: "repository",
            index: 0,
          }),
        ).toBe(`${fixture.repository}:identity`);
        expect(
          await fixture.host.executeCommand(
            "builtin-git",
            "__ws.provideTimeline",
            "fixture",
            uri,
            {},
          ),
        ).toMatchObject({ source: "fixture", items: [{ label: fixture.repository }] });
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it(
    "passes scoped extension environment changes and null removal to real terminal processes",
    { timeout: 60_000 },
    async () => {
      const previous = process.env.HARNESS_TEST_REMOVED;
      process.env.HARNESS_TEST_REMOVED = "inherited";
      const fixture = await createBuiltinFixture(null);
      try {
        await fixture.host.executeCommand(
          "builtin-git",
          "builtin.terminal.environment",
          fixture.repository,
        );
        expect(fixture.terminalRuns).toHaveLength(2);
        const output = await Promise.all(fixture.terminalRuns);
        expect(output[0]).toContain("RESULT=base:scoped|unset");
        expect(output[1]).toContain("RESULT=base|unset");
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
        if (previous === undefined) delete process.env.HARNESS_TEST_REMOVED;
        else process.env.HARNESS_TEST_REMOVED = previous;
      }
    },
  );

  it.skipIf(!available)(
    "opens a real repository, stages changes and publishes real SCM resource groups",
    { timeout: 60_000 },
    async () => {
      const fixture = await createBuiltinFixture(true);
      try {
        const initial = await fixture.host.executeCommand<{
          enabled: boolean;
          working: { path: string }[];
          untracked: { path: string }[];
        }>("builtin-git", "builtin.git.probe", fixture.repository, "status");
        fixture.record("gitStatus", initial);
        expect(initial.enabled).toBe(true);
        expect(initial).toMatchObject({ headContent: "original\n", headDocument: "original\n" });
        expect([...initial.working, ...initial.untracked].map((change) => change.path)).toEqual(
          expect.arrayContaining([
            join(fixture.repository, "tracked.txt"),
            join(fixture.repository, "untracked.txt"),
          ]),
        );
        const staged = await fixture.host.executeCommand<{ index: { path: string }[] }>(
          "builtin-git",
          "builtin.git.probe",
          fixture.repository,
          "stage",
        );
        fixture.record("gitStaged", staged);
        expect(staged.index.map((change) => change.path).sort()).toEqual([
          join(fixture.repository, "tracked.txt"),
          join(fixture.repository, "untracked.txt"),
        ]);
        expect(fixture.git("diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([
          "tracked.txt",
          "untracked.txt",
        ]);
        const provider = [...fixture.scm.providers.values()].find(
          (provider) => provider.rootPath === fixture.repository,
        );
        expect(provider).toBeDefined();
        expect(provider!.groups.get("index")?.resources.sort()).toEqual([
          join(fixture.repository, "tracked.txt"),
          join(fixture.repository, "untracked.txt"),
        ]);
        await fixture.host.executeCommand(
          "builtin-git",
          "builtin.git.probe",
          fixture.repository,
          "unstage",
        );
        expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );
});
