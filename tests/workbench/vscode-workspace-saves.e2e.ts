import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

test("workspace save APIs write registered file editors and keep failed working copies dirty", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-workspace-saves-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "save-fixture");
  const workspace = join(root, "active");
  const otherRoot = join(root, "other");
  const fixtureUrl = "/tests/vscode-workspace-saves.fixture.ts";
  const session = "workspace-saves";
  try {
    mkdirSync(workspace);
    mkdirSync(otherRoot);
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "save-fixture",
        publisher: "regression",
        version: "1.0.0",
        main: "./extension.cjs",
        activationEvents: ["onCommand:saveFixture.save"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(
    vscode.commands.registerCommand("saveFixture.save", async (name) => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
      const result = await vscode.workspace.save(uri);
      return result && { path: result.fsPath, uri: result instanceof vscode.Uri };
    }),
    vscode.commands.registerCommand("saveFixture.virtual", () =>
      vscode.workspace.save(vscode.Uri.parse("fixture:/readonly.ts"))),
    vscode.commands.registerCommand("saveFixture.all", (includeUntitled) =>
      vscode.workspace.saveAll(includeUntitled)),
  );
};
`,
    );

    await page.route("**/workspace-save-fixture", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
    );
    await page.goto("/workspace-save-fixture");
    await page.evaluate(
      async ({ fixtureUrl, workspace, otherRoot }) =>
        (await import(fixtureUrl)).setup(workspace, otherRoot),
      { fixtureUrl, workspace, otherRoot },
    );
    const runtime = await createBuiltinLanguageHost(root, async (_session, method, args) => {
      if (method !== "workspace.save" && method !== "workspace.saveAll") return { handled: false };
      return {
        handled: true,
        result: await page.evaluate(
          async ({ fixtureUrl, method, args }) => (await import(fixtureUrl)).dispatch(method, args),
          { fixtureUrl, method, args },
        ),
      };
    });
    try {
      await runtime.host.scanExtensions(extensions);
      await runtime.host.startSession(session, [workspace], { storageRoot: join(root, "storage") });
      const inspect = () =>
        page.evaluate(async (url) => (await import(url)).snapshot(), fixtureUrl);
      const fileName = "first # draft.ts";
      expect(await runtime.host.executeCommand(session, "saveFixture.save", fileName)).toEqual({
        path: join(workspace, fileName),
        uri: true,
      });
      expect(
        await runtime.host.executeCommand(session, "saveFixture.save", "hidden.ts"),
      ).toBeUndefined();
      expect(await runtime.host.executeCommand(session, "saveFixture.virtual")).toBeUndefined();
      expect(await runtime.host.executeCommand(session, "saveFixture.all")).toBe(false);
      const afterFailure = await inspect();
      expect(afterFailure.writes.sort()).toEqual(["blocked.ts", fileName, "split.ts"]);
      expect(afterFailure.dirty).toEqual(["blocked.ts", "hidden.ts", "other.ts"]);
      expect(afterFailure.saved).toMatchObject({
        [fileName]: `changed ${fileName}`,
        "blocked.ts": "initial",
        "split.ts": "changed split.ts",
        "hidden.ts": "initial",
        "clean.ts": "initial",
        "other.ts": "initial",
      });

      await page.evaluate(async (url) => (await import(url)).unblock(), fixtureUrl);
      expect(await runtime.host.executeCommand(session, "saveFixture.all", true)).toBe(true);
      const afterRetry = await inspect();
      expect(afterRetry.writes.sort()).toEqual(["blocked.ts", "blocked.ts", fileName, "split.ts"]);
      expect(afterRetry.saved["blocked.ts"]).toBe("changed blocked.ts");
      expect(afterRetry.dirty).toEqual(["hidden.ts", "other.ts"]);
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.dispose(session);
    }
  } finally {
    await page.evaluate(async (url) => (await import(url)).dispose(), fixtureUrl).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
