import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionSource = `
const vscode = require("vscode");
const disk = require("node:fs/promises");
const path = require("node:path");

exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.commands.registerCommand("transfer.run", async root => {
    const fs = vscode.workspace.fs;
    const providerRoot = path.join(root, "provider");
    const backingUri = uri => vscode.Uri.file(path.join(providerRoot, uri.authority, uri.path));
    const changes = new vscode.EventEmitter();
    subscriptions.push(changes, vscode.workspace.registerFileSystemProvider("transfer-fixture", {
      onDidChangeFile: changes.event,
      watch: () => new vscode.Disposable(() => {}),
      stat: uri => fs.stat(backingUri(uri)),
      readDirectory: uri => fs.readDirectory(backingUri(uri)),
      readFile: uri => fs.readFile(backingUri(uri)),
      writeFile(uri, bytes, { overwrite }) {
        if (uri.path.startsWith("/blocked/")) throw vscode.FileSystemError.NoPermissions(uri);
        return disk.writeFile(backingUri(uri).fsPath, bytes, { flag: overwrite ? "w" : "wx" });
      },
      createDirectory: uri => disk.mkdir(backingUri(uri).fsPath),
      delete: (uri, options) => fs.delete(backingUri(uri), options),
      rename: (source, target, options) => fs.rename(backingUri(source), backingUri(target), options),
    }, { isCaseSensitive: true }));
    const input = vscode.Uri.file(path.join(root, "input"));
    const remote = vscode.Uri.parse("transfer-fixture://host/new/nested/copy");
    const duplicate = vscode.Uri.parse("transfer-fixture://host/duplicate");
    const local = vscode.Uri.file(path.join(root, "fresh", "destination"));
    const blocked = vscode.Uri.parse("transfer-fixture://host/blocked/copy");
    const child = (uri, ...names) => vscode.Uri.joinPath(uri, ...names);
    const bytes = async uri => [...await fs.readFile(child(uri, "deep", "sample.bin"))];
    async function errorCode(operation) {
      try {
        await operation();
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError)) throw error;
        return error.code;
      }
      return "unexpected success";
    }

    await fs.copy(input, remote);
    const copied = await bytes(remote);
    const empty = await fs.readDirectory(child(remote, "empty"));
    await fs.copy(remote, duplicate);
    const keepDestination = await errorCode(() => fs.copy(remote, duplicate));
    const selfCopy = await errorCode(() => fs.copy(remote, child(remote, "self")));
    const childrenAfterSelfCopy = (await fs.readDirectory(remote)).map(([name]) => name).sort();
    await fs.writeFile(child(duplicate, "extra.bin"), new Uint8Array([1]));
    await fs.copy(remote, duplicate, { overwrite: true });
    const extra = await errorCode(() => fs.stat(child(duplicate, "extra.bin")));
    await fs.rename(duplicate, local);
    const moved = await bytes(local);
    const oldLocation = await errorCode(() => fs.stat(duplicate));
    const failedMove = await errorCode(() => fs.rename(input, blocked));
    const partialLocation = await errorCode(() => fs.stat(blocked));
    return {
      copied, empty, keepDestination, selfCopy, childrenAfterSelfCopy, extra,
      moved, oldLocation, failedMove, partialLocation, original: await bytes(input),
    };
  }));
};
`;

it("copies and moves directory trees through filesystem providers without discarding a failed source", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-fs-transfer-"));
  try {
    const extensions = join(root, "extensions");
    const extension = join(extensions, "transfer");
    mkdirSync(extension, { recursive: true });
    mkdirSync(join(root, "provider", "host"), { recursive: true });
    mkdirSync(join(root, "input", "deep"), { recursive: true });
    mkdirSync(join(root, "input", "empty"));
    writeFileSync(join(root, "input", "deep", "sample.bin"), new Uint8Array([0, 128, 255]));
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "transfer",
        publisher: "fixture",
        version: "1.0.0",
        main: "./extension.cjs",
        activationEvents: ["onCommand:transfer.run"],
      }),
    );
    writeFileSync(join(extension, "extension.cjs"), extensionSource);
    const fixture = await createBuiltinLanguageHost(root);
    const session = "fs-transfer";
    try {
      await fixture.host.scanExtensions(extensions);
      await fixture.host.startSession(session, [root], { storageRoot: join(root, "storage") });
      expect(await fixture.host.executeCommand(session, "transfer.run", root)).toEqual({
        copied: [0, 128, 255],
        empty: [],
        keepDestination: "FileExists",
        selfCopy: "NoPermissions",
        childrenAfterSelfCopy: ["deep", "empty"],
        extra: "FileNotFound",
        moved: [0, 128, 255],
        oldLocation: "FileNotFound",
        failedMove: "NoPermissions",
        partialLocation: "FileNotFound",
        original: [0, 128, 255],
      });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.dispose(session);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
