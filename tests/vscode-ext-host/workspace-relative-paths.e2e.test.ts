import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("resolves nested workspace folders and labels their roots and descendants", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vscode-workspace-paths-"));
  const parent = join(temp, "Parent");
  const nested = join(parent, "nested");
  const extensions = join(temp, "extensions");
  const extension = join(extensions, "paths");
  const outside = parent + "-external";
  const caseVariant = join(temp, "PARENT", "index.ts");
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "workspace-relative-paths";
  const stop = host.onMainThreadCall((_session, _method, _args, id) => {
    host.resolveMainCall(id, undefined);
  });
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(extension, { recursive: true });
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        publisher: "test",
        name: "paths",
        version: "1.0.0",
        main: "./index.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    );
    await writeFile(
      join(extension, "index.cjs"),
      `
const { Uri, commands, workspace } = require("vscode");
exports.activate = ({ subscriptions }) => {
  const { asRelativePath, getWorkspaceFolder } = workspace;
  subscriptions.push(commands.registerCommand("test.workspacePaths", (parent, nested, outside, caseVariant) => {
    const childRoot = Uri.file(nested);
    const withTrailingSlash = childRoot.with({ path: childRoot.path + "/" });
    const descendant = Uri.joinPath(childRoot, "src", "index.ts").with({ query: "open" });
    return {
      nestedFolder: getWorkspaceFolder(withTrailingSlash)?.name,
      nestedRoot: asRelativePath(childRoot),
      explicitNestedRoot: asRelativePath(withTrailingSlash, false),
      parentRoot: asRelativePath(parent, true),
      descendant: asRelativePath(descendant),
      descendantWithoutFolder: asRelativePath(descendant, false),
      outside: asRelativePath(outside, true),
      otherScheme: getWorkspaceFolder(descendant.with({ scheme: "archive" })) === undefined,
      otherAuthority: getWorkspaceFolder(descendant.with({ authority: "remote" })) === undefined,
      caseVariant: getWorkspaceFolder(Uri.file(caseVariant))?.name ?? null,
    };
  }));
};
`,
    );
    await host.scanExtensions(extensions);
    await host.startSession(session, [parent, nested], { storageRoot: join(temp, "storage") });
    await host.activateByEvent(session, "onStartupFinished");
    const paths = await host.executeCommand(
      session,
      "test.workspacePaths",
      parent,
      nested,
      outside,
      caseVariant,
    );
    expect(paths).toEqual({
      nestedFolder: "nested",
      nestedRoot: "Parent/nested",
      explicitNestedRoot: "nested",
      parentRoot: parent,
      descendant: "nested/src/index.ts",
      descendantWithoutFolder: "src/index.ts",
      outside,
      otherScheme: true,
      otherAuthority: true,
      caseVariant: process.platform === "linux" ? null : "Parent",
    });
  } finally {
    stop();
    await fixture.dispose(session);
    await rm(temp, { recursive: true, force: true });
  }
});
