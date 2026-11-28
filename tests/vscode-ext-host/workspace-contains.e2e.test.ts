import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const probe = String.raw`
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(v.commands.registerCommand("contains.active", name =>
    v.extensions.getExtension("fixture." + name)?.isActive ?? false,
  ));
};
`;

it("activates workspaceContains extensions on folder open, folder addition and extension install", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-workspace-contains-"));
  const extensions = join(root, "extensions");
  const install = (name: string, event: string, source = "exports.activate = () => {};") => {
    const location = join(extensions, name);
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, "extension.cjs"), source);
    writeFileSync(
      join(location, "package.json"),
      JSON.stringify({
        publisher: "fixture",
        name,
        version: "1.0.0",
        main: "./extension.cjs",
        activationEvents: [event],
      }),
    );
  };
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(join(first, "nested"), { recursive: true });
  mkdirSync(second);
  writeFileSync(join(first, "nested", ".marker"), "");
  writeFileSync(join(first, "nested", "package.json"), "{}");
  writeFileSync(join(second, "package.json"), "{}");
  writeFileSync(join(second, "installed.marker"), "");
  install("probe", "onCommand:contains.active", probe);
  install("glob", "workspaceContains:**/.marker");
  install("exact", "workspaceContains:package.json");
  install("missing", "workspaceContains:**/missing.marker");

  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "workspace-contains";
  const unsubscribe = host.onMainThreadCall(async (_id, _method, _args, request) => {
    if (request) host.resolveMainCall(request, undefined);
  });
  const active = (name: string) => host.executeCommand(session, "contains.active", name);
  const expectActive = (name: string) =>
    vi.waitFor(async () => expect(await active(name)).toBe(true));
  try {
    await host.scanExtensions(extensions);
    await host.startSession(session, [first], { storageRoot: join(root, "storage") });
    await expectActive("glob");
    expect(await active("exact")).toBe(false);
    expect(await active("missing")).toBe(false);

    await host.executeCommand(session, "__ws.onDidChangeWorkspaceFolders", {
      added: [{ uri: Uri.file(second).toJSON(), index: 1, name: "second" }],
      removed: [],
    });
    await expectActive("exact");

    install("installed", "workspaceContains:installed.marker");
    await host.scanExtensions(extensions);
    await expectActive("installed");
  } finally {
    unsubscribe();
    await fixture.dispose(session);
    rmSync(root, { recursive: true, force: true });
  }
});
