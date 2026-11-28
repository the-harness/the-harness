import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { serveWebviewResource } from "../../packages/vscode-ext-host/src/webview-resources.ts";

it("serves allowed double-dot filenames while rejecting traversal, escaping symlinks and disposed panels", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "webview-resources-"));
  const extension = join(root, "extension"),
    allowed = join(root, "allowed");
  mkdirSync(extension);
  mkdirSync(allowed);
  mkdirSync(join(allowed, "..assets"));
  writeFileSync(join(allowed, "..assets", "style.css"), ".safe { color: red }");
  writeFileSync(join(root, "outside.css"), "outside");
  symlinkSync(join(root, "outside.css"), join(allowed, "escape.css"));
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "resource-boundary",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.resourceBoundary"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
    const vscode = require("vscode"); let panel;
    exports.activate = context => {
      context.subscriptions.push(vscode.commands.registerCommand("audit.resourceBoundary", (root, operation) => {
        if (operation === "dispose") { panel.dispose(); return; }
        panel = vscode.window.createWebviewPanel("resource-boundary", "Resources", 1, { localResourceRoots: [vscode.Uri.file(root + "/allowed")] });
        context.subscriptions.push(panel);
        return [root + "/allowed/..assets/style.css", root + "/outside.css", root + "/allowed/escape.css"].map(path => panel.webview.asWebviewUri(vscode.Uri.file(path)).toString());
      }));
    };
  `,
  );
  const fixture = await createExtensionHostFixture();
  const off = fixture.service.onMainThreadCall(async (_session, _method, _args, requestId) => {
    if (requestId) fixture.service.resolveMainCall(requestId, true);
  });
  const server = createServer(
    (request, response) => void serveWebviewResource(fixture.service, request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await fixture.service.scanExtensions(root);
    await fixture.service.startSession("resources", [root], {
      storageRoot: join(root, "storage"),
      webviewResourceBase: `http://127.0.0.1:${address.port}/resources/`,
    });
    const [valid, outside, symlink] = await fixture.service.executeCommand<string[]>(
      "resources",
      "audit.resourceBoundary",
      root,
    );
    const success = await fetch(valid!);
    expect(success.status).toBe(200);
    expect(success.headers.get("content-type")).toBe("text/css");
    expect(await success.text()).toBe(".safe { color: red }");
    expect((await fetch(outside!)).status).toBe(404);
    expect((await fetch(symlink!)).status).toBe(404);
    expect((await fetch(valid!, { method: "POST" })).status).toBe(405);
    await fixture.service.executeCommand("resources", "audit.resourceBoundary", root, "dispose");
    expect((await fetch(valid!)).status).toBe(404);
  } finally {
    await fixture.dispose("resources");
    off();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it.each(["commonjs", "module"])(
  "limits default Webview roots to the creating %s extension and workspace",
  async (format) => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "webview-owner-"));
    const extensions = join(root, "extensions"),
      owner = join(extensions, "owner"),
      other = join(extensions, "other"),
      workspace = join(root, "workspace");
    for (const directory of [owner, other, workspace]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(owner, "own.css"), "owner");
    writeFileSync(join(other, "other.css"), "other");
    writeFileSync(join(workspace, "workspace.css"), "workspace");
    writeFileSync(
      join(other, "package.json"),
      JSON.stringify({ publisher: "audit", name: "other", version: "1.0.0" }),
    );
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({
        publisher: "audit",
        name: "owner",
        version: "1.0.0",
        type: format,
        main: "extension.js",
        activationEvents: ["onCommand:audit.ownerResources"],
      }),
    );
    writeFileSync(
      join(owner, "extension.js"),
      `${format === "module" ? 'import * as vscode from "vscode"; export function activate(context)' : 'const vscode = require("vscode"); exports.activate = function(context)'} {
    class Item extends vscode.CompletionItem {}
    context.subscriptions.push(vscode.commands.registerCommand("audit.ownerResources", async paths => {
      await Promise.resolve();
      const panel = vscode.window.createWebviewPanel("owner", "Owner", 1, {}); context.subscriptions.push(panel);
      return paths.map(path => panel.webview.asWebviewUri(vscode.Uri.file(path)).toString());
    }));
  }`,
    );
    const fixture = await createExtensionHostFixture();
    const off = fixture.service.onMainThreadCall(async (_session, _method, _args, requestId) => {
      if (requestId) fixture.service.resolveMainCall(requestId, true);
    });
    const server = createServer(
      (request, response) => void serveWebviewResource(fixture.service, request, response),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      await fixture.service.scanExtensions(extensions);
      await fixture.service.startSession(format, [workspace], {
        storageRoot: join(root, "storage"),
        webviewResourceBase: `http://127.0.0.1:${address.port}/${format}/`,
      });
      const urls = await fixture.service.executeCommand<string[]>(format, "audit.ownerResources", [
        join(owner, "own.css"),
        join(other, "other.css"),
        join(workspace, "workspace.css"),
      ]);
      expect(await (await fetch(urls[0]!)).text()).toBe("owner");
      expect((await fetch(urls[1]!)).status).toBe(404);
      expect(await (await fetch(urls[2]!)).text()).toBe("workspace");
    } finally {
      await fixture.dispose(format);
      off();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
