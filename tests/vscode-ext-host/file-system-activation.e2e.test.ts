import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const caller = String.raw`
const v = require("vscode");
const fs = v.workspace.fs;
const uri = scheme => v.Uri.parse(scheme + "://host/document.txt");
const text = async resource => new TextDecoder().decode(await fs.readFile(resource));
exports.activate = ({ subscriptions }) => {
  subscriptions.push(
    v.commands.registerCommand("activation.files", async () => {
      const resource = uri("lazy-fs");
      const before = fs.isWritableFileSystem(resource.scheme);
      const [contents, stat] = await Promise.all([text(resource), fs.stat(resource)]);
      const target = uri("lazy-target");
      await fs.copy(resource, target, { overwrite: true });
      return { wasUnknown: before === undefined, contents, size: stat.size, copied: await text(target) };
    }),
    v.commands.registerCommand("activation.documents", async () => {
      const open = async scheme => (await v.workspace.openTextDocument(uri(scheme))).getText();
      return await Promise.all([open("lazy-open"), open("lazy-text")]);
    }),
    v.commands.registerCommand("activation.watch", () => {
      subscriptions.push(v.workspace.createFileSystemWatcher(
        new v.RelativePattern(v.Uri.parse("lazy-watch://host/"), "**"),
      ));
    }),
    v.commands.registerCommand("activation.watchCount", () =>
      v.extensions.getExtension("fixture.lazy-watch").exports?.watchCount() ?? 0,
    ),
  );
};
`;

const provider = String.raw`
const v = require("vscode");
exports.activate = async ({ subscriptions, extension }) => {
  const scheme = extension.id.split(".").at(-1);
  const marker = v.Uri.joinPath(v.workspace.workspaceFolders[0].uri, "marker.txt");
  const markerBytes = await v.workspace.fs.readFile(marker);
  if (scheme === "lazy-text") {
    subscriptions.push(v.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: () => "text provider",
    }));
    return;
  }
  let bytes = scheme === "lazy-target" ? undefined : markerBytes;
  let watches = 0;
  const events = new v.EventEmitter();
  subscriptions.push(events, v.workspace.registerFileSystemProvider(scheme, {
    onDidChangeFile: events.event,
    readFile: () => bytes,
    stat(uri) {
      if (!bytes) throw v.FileSystemError.FileNotFound(uri);
      return { type: v.FileType.File, ctime: 0, mtime: 0, size: bytes.length };
    },
    writeFile: (_uri, next) => { bytes = next; },
    watch: () => { watches++; return new v.Disposable(() => watches--); },
  }));
  return { watchCount: () => watches };
};
`;

it("activates filesystem providers on first file access, document open or watch", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-fs-activation-"));
  const extensions = join(root, "extensions");
  const install = (name: string, event: string, source: string) => {
    const extension = join(extensions, name);
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "extension.cjs"), source);
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "fixture",
        name,
        version: "1.0.0",
        main: "./extension.cjs",
        activationEvents: [event],
      }),
    );
  };
  install("caller", "onCommand:activation.files", caller);
  for (const scheme of ["lazy-fs", "lazy-target", "lazy-open", "lazy-text", "lazy-watch"])
    install(scheme, `onFileSystem:${scheme}`, provider);
  writeFileSync(join(root, "marker.txt"), "filesystem");
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "fs-activation";
  const unsubscribe = host.onMainThreadCall(async (_id, method, _args, request) => {
    if (request)
      host.resolveMainCall(
        request,
        method === "workspace.resolveDocumentLanguage" ? "plaintext" : undefined,
      );
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    expect(await host.executeCommand(session, "activation.files")).toEqual({
      wasUnknown: true,
      contents: "filesystem",
      size: 10,
      copied: "filesystem",
    });
    expect(await host.executeCommand(session, "activation.documents")).toEqual([
      "filesystem",
      "text provider",
    ]);
    expect(await host.executeCommand(session, "activation.watchCount")).toBe(0);
    await host.executeCommand(session, "activation.watch");
    await vi.waitFor(async () => {
      expect(await host.executeCommand(session, "activation.watchCount")).toBe(1);
    });
  } finally {
    unsubscribe();
    await fixture.dispose(session);
    rmSync(root, { recursive: true, force: true });
  }
});
