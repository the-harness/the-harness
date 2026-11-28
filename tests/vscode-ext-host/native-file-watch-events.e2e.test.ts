import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type { WorkspaceWatchEvent } from "../../packages/ui-workspace/src/rpc.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("reports real disk edits and atomic saves as changes to extension watchers", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vscode-native-watch-"));
  const fixture = await createExtensionHostFixture();
  const { service: host, modules, scope } = fixture;
  const session = "native-file-watch";
  const workspace = join(temp, "workspace");
  const extensions = join(temp, "extensions");
  const extension = join(extensions, "watch");
  const existing = join(workspace, "existing.ts");
  const added = join(workspace, "added.ts");
  const renamed = join(workspace, "renamed.ts");
  const marker = join(workspace, "watch-ready");
  const replacement = join(temp, "replacement");
  let unsubscribe: (() => void) | undefined;
  const stop = host.onMainThreadCall((_session, _method, _args, id) => {
    host.resolveMainCall(id, undefined);
  });

  try {
    await mkdir(workspace);
    await mkdir(extension, { recursive: true });
    await writeFile(existing, "original\n");
    await writeFile(marker, "");
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "test",
        name: "watch",
        version: "1.0.0",
        main: "./index.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, "index.cjs"),
      `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const events = [];
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.ts");
  const record = type => uri => events.push([type, vscode.workspace.asRelativePath(uri)]);
  subscriptions.push(watcher,
    watcher.onDidChange(record("change")),
    watcher.onDidCreate(record("create")),
    watcher.onDidDelete(record("delete")),
    vscode.commands.registerCommand("test.watchEvents", () => events),
  );
};
`,
    );
    await host.scanExtensions(extensions);
    await host.startSession(session, [workspace], { storageRoot: join(temp, "storage") });
    await host.activateByEvent(session, "onStartupFinished");

    const { WorkspaceFsService } = await modules.load<
      typeof import("../../packages/ui-workspace/src/node.ts")
    >("/packages/ui-workspace/src/node.ts");
    scope.provide(WorkspaceFsService);
    const diskEvents: WorkspaceWatchEvent[] = [];
    unsubscribe = scope.get(WorkspaceFsService).subscribeRoots([workspace], (event) => {
      diskEvents.push(event);
    });
    await expect
      .poll(async () => {
        if (diskEvents.some((event) => event.path === marker)) return true;
        await appendFile(marker, "+");
        return false;
      })
      .toBe(true);

    const extensionEvents = async () => {
      for (const event of diskEvents.splice(0)) {
        await host.executeCommand(session, "__ws.fileChanged", event);
      }
      return await host.executeCommand(session, "test.watchEvents");
    };

    expect(await extensionEvents()).toEqual([]);
    await writeFile(replacement, "replacement\n");
    await rename(replacement, existing);
    await expect.poll(extensionEvents).toEqual([["change", "existing.ts"]]);
    await appendFile(existing, "edited\n");
    await expect.poll(extensionEvents).toEqual([
      ["change", "existing.ts"],
      ["change", "existing.ts"],
    ]);
    await writeFile(added, "new\n");
    await expect.poll(extensionEvents).toContainEqual(["create", "added.ts"]);
    await rename(added, renamed);
    await expect.poll(extensionEvents).toEqual(
      expect.arrayContaining([
        ["delete", "added.ts"],
        ["create", "renamed.ts"],
      ]),
    );
    await rm(renamed);
    await expect.poll(extensionEvents).toContainEqual(["delete", "renamed.ts"]);
  } finally {
    unsubscribe?.();
    stop();
    await fixture.dispose(session);
    await rm(temp, { recursive: true, force: true });
  }
}, 15_000);
