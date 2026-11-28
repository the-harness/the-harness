import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extension = `
const vscode = require("vscode");
const path = require("node:path");
const { fs } = vscode.workspace;
const { FileType, Uri } = vscode;

exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.commands.registerCommand("fixture.symlinks", async (root) => {
    const links = Uri.file(path.join(root, "links"));
    const link = (name) => Uri.joinPath(links, name);
    const errorCode = (operation) => operation.then(() => null, (error) => error.code);
    const entries = Object.fromEntries(await fs.readDirectory(links));
    const [dangling, fileLink, directoryLink] = await Promise.all([
      fs.stat(link("dangling")), fs.stat(link("note-link.md")), fs.stat(link("folder-link")),
    ]);
    const changes = new vscode.EventEmitter();
    let destinationExists = false;
    subscriptions.push(changes, vscode.workspace.registerFileSystemProvider("fixture-copy", {
      onDidChangeFile: changes.event,
      stat(uri) {
        if (!destinationExists) throw vscode.FileSystemError.FileNotFound(uri);
        return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      },
      createDirectory() { destinationExists = true; },
      delete() { destinationExists = false; },
    }));
    const target = Uri.parse("fixture-copy:/destination");
    const copyError = await errorCode(fs.copy(links, target));
    return {
      entries,
      symbolicLink: FileType.SymbolicLink,
      fileLinkType: fileLink.type,
      fileSize: fileLink.size,
      directoryLinkType: directoryLink.type,
      danglingType: dangling.type,
      danglingRead: await errorCode(fs.readFile(link("dangling"))),
      missingStat: await errorCode(fs.stat(link("absent"))),
      missingDirectory: await errorCode(fs.readDirectory(link("absent"))),
      copyError,
      partialCopy: await errorCode(fs.stat(target)),
    };
  }));
};
`;

it.skipIf(process.platform === "win32")(
  "lists ordinary entries alongside symbolic links and reports broken targets separately",
  async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "vscode-fs-symlinks-"));
    try {
      const extensions = join(root, "extensions");
      const fixture = join(extensions, "symlinks");
      const links = join(root, "links");
      mkdirSync(fixture, { recursive: true });
      mkdirSync(join(links, "folder"), { recursive: true });
      writeFileSync(join(links, "note.md"), "text");
      symlinkSync("note.md", join(links, "note-link.md"));
      symlinkSync("folder", join(links, "folder-link"), "dir");
      symlinkSync("does-not-exist", join(links, "dangling"));
      symlinkSync("loop", join(links, "loop"));
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "symlinks",
          publisher: "fixture",
          version: "1.0.0",
          main: "./index.cjs",
          activationEvents: ["onCommand:fixture.symlinks"],
        }),
      );
      writeFileSync(join(fixture, "index.cjs"), extension);

      const { service, dispose } = await createExtensionHostFixture();
      const session = "filesystem-symlinks";
      const off = service.onMainThreadCall((_id, _method, _args, request) => {
        service.resolveMainCall(request);
      });
      try {
        await service.scanExtensions(extensions);
        await service.startSession(session, [root], { storageRoot: join(root, "storage") });
        assert.deepEqual(await service.executeCommand(session, "fixture.symlinks", root), {
          entries: { "note.md": 1, folder: 2, "note-link.md": 65, "folder-link": 66, dangling: 64 },
          symbolicLink: 64,
          fileLinkType: 65,
          fileSize: 4,
          directoryLinkType: 66,
          danglingType: 64,
          danglingRead: "FileNotFound",
          missingStat: "FileNotFound",
          missingDirectory: "FileNotFound",
          copyError: "ELOOP",
          partialCopy: "FileNotFound",
        });
      } finally {
        try {
          await dispose(session);
        } finally {
          off();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
