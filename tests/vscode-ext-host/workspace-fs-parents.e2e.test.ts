import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const probe = String.raw`
const v = require("vscode");
const { posix } = require("node:path");
const fs = v.workspace.fs;
const { FileSystemError, FileType, FilePermission } = v;
const bytes = Uint8Array.of(0, 255, 128, 1);

async function errorCode(action) {
  try {
    await action();
    return null;
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return error.code;
  }
}

function memoryProvider(events) {
  const entries = new Map([
    ["/", { type: FileType.Directory }],
    ["/blocked", { type: FileType.File }],
    ["/readonly", { type: FileType.File, permissions: FilePermission.Readonly, bytes }],
  ]);
  const check = uri => {
    if (uri.authority !== "tenant" || uri.query !== "branch=work" || uri.fragment !== "root")
      throw Error("Directory operations changed the provider URI identity");
  };
  const requireParent = uri => {
    const parent = posix.dirname(uri.path);
    if (entries.get(parent)?.type !== FileType.Directory)
      throw FileSystemError.FileNotFound(uri);
  };
  return {
    entries,
    onDidChangeFile: events.event,
    stat(uri) {
      check(uri);
      const entry = entries.get(uri.path);
      if (!entry) throw FileSystemError.FileNotFound(uri);
      return { ...entry, ctime: 0, mtime: 0, size: entry.bytes?.length ?? 0 };
    },
    createDirectory(uri) {
      check(uri);
      requireParent(uri);
      if (entries.has(uri.path)) throw FileSystemError.FileExists(uri);
      entries.set(uri.path, { type: FileType.Directory });
    },
    writeFile(uri, data, options) {
      check(uri);
      requireParent(uri);
      if (!options.create) throw Error("Expected create mode");
      if (entries.has(uri.path) && !options.overwrite) throw FileSystemError.FileExists(uri);
      entries.set(uri.path, { type: FileType.File, bytes: data.slice() });
    },
    readFile(uri) {
      check(uri);
      const data = entries.get(uri.path)?.bytes;
      if (!data) throw FileSystemError.FileNotFound(uri);
      return data;
    },
  };
}

exports.activate = ({ subscriptions }) => {
  const events = new v.EventEmitter();
  const remote = v.Uri.parse("test-dirs://tenant/?branch=work#root");
  const memory = memoryProvider(events);
  subscriptions.push(
    events,
    v.workspace.registerFileSystemProvider(remote.scheme, memory),
    v.commands.registerCommand("fsParents.write", async () => {
      const native = v.Uri.joinPath(v.workspace.workspaceFolders[0].uri, "native/cache/bytes");
      const directory = v.Uri.joinPath(remote, "data/cache");
      const binary = v.Uri.joinPath(remote, "nested/parents/bytes");
      const destination = v.Uri.joinPath(remote, "copies/remote/bytes");
      const localWrite = await errorCode(() => fs.writeFile(native, bytes));
      const recursiveMkdir = await errorCode(() => Promise.all([
        fs.createDirectory(directory), fs.createDirectory(directory),
      ]));
      const remoteWrite = await errorCode(() => fs.writeFile(binary, bytes));
      const overwrite = await errorCode(() => fs.writeFile(binary, Uint8Array.of(42)));
      const blocked = await errorCode(() => fs.writeFile(v.Uri.joinPath(remote, "blocked/x"), bytes));
      const readonly = await errorCode(() => fs.writeFile(v.Uri.joinPath(remote, "readonly"), Uint8Array.of(42)));
      const directoryWrite = await errorCode(() => fs.writeFile(directory, bytes));
      const copy = await errorCode(() => fs.copy(native, destination));
      return {
        localWrite, recursiveMkdir, remoteWrite, overwrite, blocked, readonly, directoryWrite, copy,
        nativeBytes: localWrite ? null : [...await fs.readFile(native)],
        remoteBytes: remoteWrite ? null : [...await fs.readFile(binary)],
        copiedBytes: copy ? null : [...await fs.readFile(destination)],
        readonlyBytes: [...await fs.readFile(v.Uri.joinPath(remote, "readonly"))],
      };
    }),
    v.commands.registerCommand("fsParents.replaceProvider", async () => {
      const uri = v.Uri.parse("test-race://tenant/pending/bytes?branch=work#root");
      const old = memoryProvider(events);
      const newProvider = memoryProvider(events);
      const started = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const registration = v.workspace.registerFileSystemProvider(uri.scheme, {
        ...old,
        async stat(resource) {
          if (resource.path === "/pending") {
            started.resolve();
            await resume.promise;
          }
          return old.stat(resource);
        },
      });
      const pending = errorCode(() => fs.writeFile(uri, bytes));
      let replacement;
      try {
        await Promise.race([started.promise, pending.then(code => {
          throw Error("Write settled before checking its parent: " + code);
        })]);
        registration.dispose();
        replacement = v.workspace.registerFileSystemProvider(uri.scheme, newProvider);
        resume.resolve();
        return {
          code: await pending,
          oldCreated: old.entries.has("/pending"),
          replacementCreated: newProvider.entries.has("/pending"),
        };
      } finally {
        resume.resolve();
        registration.dispose();
        replacement?.dispose();
      }
    }),
  );
};
`;

it("creates missing write parents and recursive directories through workspace.fs", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-fs-parents-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "fs-parents");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "fs-parents",
      publisher: "audit",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(join(extension, "index.cjs"), probe);

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "workspace-fs-parents";
  const unlisten = host.onMainThreadCall(async (_id, _method, _args, request) => {
    host.resolveMainCall(request);
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");
    expect(await host.executeCommand(session, "fsParents.write")).toEqual({
      localWrite: null,
      recursiveMkdir: null,
      remoteWrite: null,
      overwrite: null,
      blocked: "FileNotADirectory",
      readonly: "NoPermissions",
      directoryWrite: "FileIsADirectory",
      copy: null,
      nativeBytes: [0, 255, 128, 1],
      remoteBytes: [42],
      copiedBytes: [0, 255, 128, 1],
      readonlyBytes: [0, 255, 128, 1],
    });
    expect(await host.executeCommand(session, "fsParents.replaceProvider")).toEqual({
      code: "Unavailable",
      oldCreated: false,
      replacementCreated: false,
    });
  } finally {
    unlisten();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
