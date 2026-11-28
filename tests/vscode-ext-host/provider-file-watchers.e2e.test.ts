import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("matches provider watchers by full URI and preserves file watch options and lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "vscode-provider-watch-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "watch");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "watch",
      publisher: "audit",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(extension, "index.cjs"),
    String.raw`
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  const uri = value => vscode.Uri.parse(value);
  const pattern = (base, glob) => new vscode.RelativePattern(uri(base), glob);
  const changes = new vscode.EventEmitter();
  const watched = [];
  const stopped = [];
  const exactEvents = [];
  const nestedEvents = [];
  const workspaceEvents = [];
  const localEvents = [];
  const provider = {
    onDidChangeFile: changes.event,
    watch(resource, options) {
      watched.push({ uri: resource.toString(), options });
      return new vscode.Disposable(() => stopped.push(resource.toString()));
    },
  };
  const exact = vscode.workspace.createFileSystemWatcher(
    pattern("fixture-watch://west/project/target.ts", "*"), true, false, true,
  );
  const nested = vscode.workspace.createFileSystemWatcher(
    pattern("fixture-watch://west/project", "nested/*.ts"),
  );
  const silent = vscode.workspace.createFileSystemWatcher(
    pattern("fixture-watch://west/project", "**"), true, true, true,
  );
  const workspace = vscode.workspace.createFileSystemWatcher("**/*.ts");
  const local = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ".config.ts"), "*"),
  );
  subscriptions.push(changes, exact, nested, silent, workspace, local,
    local.onDidChange(resource => localEvents.push(resource.path)),
    local.onDidCreate(resource => localEvents.push("created:" + resource.path)),
    exact.onDidChange(resource => exactEvents.push(resource.toString())),
    nested.onDidChange(resource => nestedEvents.push(resource.toString())),
    workspace.onDidChange(resource => workspaceEvents.push(resource.path)),
    workspace.onDidDelete(resource => workspaceEvents.push("deleted:" + resource.path)),
    vscode.commands.registerCommand("audit.watchEvents", () => ({ workspaceEvents, localEvents })),
    vscode.commands.registerCommand("audit.providerEvents", () => {
      const fire = (...paths) => changes.fire(paths.map(path => ({
        type: vscode.FileChangeType.Changed, uri: uri(path),
      })));
      const insensitive = vscode.workspace.registerFileSystemProvider("fixture-watch", provider);
      fire(
        "fixture-watch://west/project/target.ts",
        "fixture-watch://west/PROJECT/TARGET.TS",
        "fixture-watch://east/project/target.ts",
        "fixture-watch://west/project/nested/.config.ts",
        "fixture-watch://east/project/nested/other.ts",
        "fixture-watch://west/project-else/nested/outside.ts",
      );
      insensitive.dispose();

      const sensitive = vscode.workspace.registerFileSystemProvider(
        "fixture-watch", provider, { isCaseSensitive: true },
      );
      fire(
        "fixture-watch://west/PROJECT/TARGET.TS",
        "fixture-watch://west/project/nested/UPPER.TS",
        "fixture-watch://west/project/target.ts",
      );
      exact.dispose();
      fire("fixture-watch://west/project/target.ts");
      sensitive.dispose();
      fire("fixture-watch://west/project/nested/late.ts");
      return {
        flags: [exact.ignoreCreateEvents, exact.ignoreChangeEvents, exact.ignoreDeleteEvents],
        exactEvents, nestedEvents, watched, stopped,
        workspaceEvents: workspaceEvents.slice(),
      };
    }),
  );
};
`,
  );

  const session = "watchers";
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const stop = host.onMainThreadCall((_session, _method, _args, id) => {
    host.resolveMainCall(id, undefined);
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession(session, [workspace], {
      storageRoot: join(root, "storage"),
      configuration: {
        defaults: { "files.watcherExclude": { "**/excluded": true } },
        user: { "files.watcherExclude": { "**/kept": false } },
        workspace: {},
      },
    });
    await host.activateByEvent(session, "onStartupFinished");
    const file = "fixture-watch://west/project/target.ts";
    const folder = "fixture-watch://west/project";
    const watchOptions = [
      { uri: file, options: { recursive: false, excludes: [] } },
      { uri: folder, options: { recursive: true, excludes: ["**/excluded"] } },
    ];
    expect(await host.executeCommand(session, "audit.providerEvents")).toEqual({
      flags: [true, false, true],
      exactEvents: [file, "fixture-watch://west/PROJECT/TARGET.TS", file],
      nestedEvents: ["fixture-watch://west/project/nested/.config.ts"],
      watched: [...watchOptions, ...watchOptions],
      stopped: [file, folder, file, folder],
      workspaceEvents: [],
    });
    for (const [type, path, eventRoot] of [
      ["change", join(workspace, ".config.ts"), workspace],
      ["change", join(root, "outside.ts"), root],
      ["unlinkDir", join(workspace, "nested.ts"), workspace],
    ]) {
      await host.executeCommand(session, "__ws.fileChanged", {
        type,
        path,
        root: eventRoot,
        relativePath: relative(eventRoot, path),
      });
    }
    expect(await host.executeCommand(session, "audit.watchEvents")).toEqual({
      workspaceEvents: [join(workspace, ".config.ts"), "deleted:" + join(workspace, "nested.ts")],
      localEvents: [join(workspace, ".config.ts")],
    });
  } finally {
    stop();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
