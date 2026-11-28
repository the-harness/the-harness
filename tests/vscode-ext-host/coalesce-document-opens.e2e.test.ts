import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { Uri, type UriComponents } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const probe = String.raw`
const v = require("vscode");
const open = v.workspace.openTextDocument;
const nextTurn = () => new Promise(setImmediate);

exports.activate = ({ subscriptions }) => {
  subscriptions.push(
    v.commands.registerCommand("openFixture.file", async path => {
      const uri = v.Uri.file(path);
      const [first, second] = await Promise.all([open(uri), open(path)]);
      return { same: first === second, text: first.getText() };
    }),
    v.commands.registerCommand("openFixture.concurrent", async () => {
      const uri = v.Uri.parse("open-fixture://source/document?first#anchor");
      const other = uri.with({ query: "other" });
      const reads = [];
      const opened = [];
      const contents = Promise.withResolvers();
      const listener = v.workspace.onDidOpenTextDocument(document => {
        if (document.uri.scheme === uri.scheme) opened.push(document.uri.query);
      });
      const registration = v.workspace.registerTextDocumentContentProvider(uri.scheme, {
        async provideTextDocumentContent(resource) {
          reads.push(resource.query);
          await contents.promise;
          return resource.query;
        },
      });
      try {
        const pending = Promise.all([open(uri), open(uri), open(other), open(uri)]);
        await nextTurn();
        contents.resolve();
        const [first, repeated, distinct, again] = await pending;
        return {
          reads, opened: opened.sort(),
          same: first === repeated && first === again,
          distinct: first !== distinct,
          contents: [first.getText(), distinct.getText()],
        };
      } finally {
        registration.dispose();
        listener.dispose();
      }
    }),
    v.commands.registerCommand("openFixture.retry", async () => {
      const uri = v.Uri.parse("retry-fixture:/document");
      let reads = 0;
      let retrying = false;
      const response = Promise.withResolvers();
      const registration = v.workspace.registerTextDocumentContentProvider(uri.scheme, {
        provideTextDocumentContent() { reads++; return retrying ? "recovered" : response.promise; },
      });
      try {
        const pending = Promise.allSettled([open(uri), open(uri)]);
        await nextTurn();
        response.reject(new Error("First read failed"));
        const failures = (await pending).map(result => result.reason?.message);
        retrying = true;
        return { readsBeforeRetry: reads, failures, text: (await open(uri)).getText(), reads };
      } finally {
        registration.dispose();
      }
    }),
    v.commands.registerCommand("openFixture.replaceFileProvider", async () => {
      const uri = v.Uri.parse("replace-fs://owner/document?revision=live");
      const changed = new v.EventEmitter();
      const entered = Promise.withResolvers();
      const oldContent = Promise.withResolvers();
      const newContent = Promise.withResolvers();
      const old = v.workspace.registerFileSystemProvider(uri.scheme, {
        onDidChangeFile: changed.event,
        readFile() { entered.resolve(); return oldContent.promise; },
      });
      let replacement;
      let reads = 0;
      const encode = text => new TextEncoder().encode(text);
      try {
        const first = open(uri).then(document => document.getText(), error => error.code);
        await entered.promise;
        old.dispose();
        replacement = v.workspace.registerFileSystemProvider(uri.scheme, {
          onDidChangeFile: changed.event,
          readFile() { reads++; return newContent.promise; },
        });
        const second = open(uri);
        oldContent.resolve(encode("stale"));
        const retired = await first;
        const third = open(uri);
        newContent.resolve(encode("replacement"));
        const [current, repeated] = await Promise.all([second, third]);
        return { reads, retired, same: current === repeated, current: current.getText() };
      } finally {
        old.dispose();
        replacement?.dispose();
        changed.dispose();
      }
    }),
  );
};
`;

it("shares pending document loads without retaining failures or reusing a retired provider", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-coalesce-opens-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "open-fixture");
  const file = join(root, "document.txt");
  await mkdir(extension, { recursive: true });
  await writeFile(file, "local content");
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "open-fixture",
      publisher: "audit",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(join(extension, "index.cjs"), probe);

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "coalesce-document-opens";
  let fileReads = 0;
  const unlisten = host.onMainThreadCall(async (_id, method, args, request) => {
    if (method !== "workspace.openTextDocument") {
      host.resolveMainCall(
        request,
        method === "workspace.resolveDocumentLanguage" ? "plaintext" : undefined,
      );
      return;
    }
    try {
      fileReads++;
      const uri = Uri.from(args[0] as UriComponents);
      host.resolveMainCall(request, {
        uri: uri.toJSON(),
        text: await readFile(uri.fsPath, "utf8"),
        languageId: "plaintext",
        version: 1,
        eol: 1,
        isDirty: false,
      });
    } catch (error) {
      host.resolveMainCall(request, undefined, String(error));
    }
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], { storageRoot: join(root, "storage") });
    await host.activateByEvent(session, "onStartupFinished");
    expect(await host.executeCommand(session, "openFixture.file", file)).toEqual({
      same: true,
      text: "local content",
    });
    expect(fileReads).toBe(1);
    expect(await host.executeCommand(session, "openFixture.concurrent")).toEqual({
      reads: ["first", "other"],
      opened: ["first", "other"],
      same: true,
      distinct: true,
      contents: ["first", "other"],
    });
    expect(await host.executeCommand(session, "openFixture.retry")).toEqual({
      readsBeforeRetry: 1,
      failures: ["First read failed", "First read failed"],
      text: "recovered",
      reads: 2,
    });
    expect(await host.executeCommand(session, "openFixture.replaceFileProvider")).toEqual({
      reads: 1,
      retired: "Unavailable",
      same: true,
      current: "replacement",
    });
  } finally {
    unlisten();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
