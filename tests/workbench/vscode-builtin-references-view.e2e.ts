import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { Selection, Range, TextDocumentData, Uri } from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

test("official references view displays TypeScript file groups and opens the clicked reference selection", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "references-view/package.json")),
    "Official desktop reference bundle is not installed",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-references-view-monaco-"));
  const installed = join(root, "extensions");
  mkdirSync(installed);
  for (const name of ["references-view", "typescript-language-features"])
    cpSync(join(extensionsDirectory, name), join(installed, name), { recursive: true });
  symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
  const text = 'import { symbol } from "./lib";\nconsole.log(symbol);\n';
  const libText = "export const symbol = 42;\n";
  writeFileSync(join(root, "main.ts"), text);
  writeFileSync(join(root, "lib.ts"), libText);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["*.ts"] }),
  );
  const document = new TextDocumentData({
    uri: Uri.file(join(root, "main.ts")).toJSON(),
    text,
    languageId: "typescript",
    version: 1,
    isDirty: false,
    eol: 1,
  });
  const library = new TextDocumentData({
    uri: Uri.file(join(root, "lib.ts")).toJSON(),
    text: libText,
    languageId: "typescript",
    version: 1,
    isDirty: false,
    eol: 1,
  });
  const caret = document.positionAt(text.lastIndexOf("symbol"));
  const editor = {
    document: document.toJSON(),
    selections: [new Selection(caret, caret)],
    visibleRanges: [new Range(document.positionAt(0), document.positionAt(text.length))],
    viewColumn: 1,
    options: { tabSize: 2, insertSpaces: true },
  };
  const getBrowserErrors = await captureBrowserErrors(page);
  await page.goto("/");
  await page.evaluate(
    async ({ main, lib, offset }) => {
      const fixture = await import("/tests/vscode-builtin-editor.fixture.ts");
      fixture.openBuiltinEditor(main, offset);
      fixture.addBuiltinEditorDocument(lib);
      await fixture.dispatchBuiltinEditor("references", "commands.execute", [
        "vscode.open",
        main.uri,
      ]);
    },
    { main: document.toJSON(), lib: library.toJSON(), offset: text.lastIndexOf("symbol") },
  );
  const fixture = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (method.startsWith("tree."))
      return {
        handled: true,
        result: await page.evaluate(
          async ({ session, method, args }) =>
            (await import("/tests/vscode-tree.fixture.ts")).dispatchTreeFixture(
              session,
              method,
              args,
            ),
          { session, method, args },
        ),
      };
    if (
      method === "workspace.openTextDocument" ||
      (method === "commands.execute" && args[0] === "vscode.open")
    )
      return {
        handled: true,
        result: await page.evaluate(
          async ({ session, method, args }) =>
            (await import("/tests/vscode-builtin-editor.fixture.ts")).dispatchBuiltinEditor(
              session,
              method,
              args,
            ),
          { session, method, args },
        ),
      };
    return { handled: false };
  });
  await page.exposeFunction("invokeBuiltinTreeCommand", (command: string, args: unknown[]) =>
    fixture.host.executeCommand("references", command, ...args),
  );
  await page.evaluate(async () =>
    (await import("/tests/vscode-tree.fixture.ts")).openTreeFixture("references"),
  );
  try {
    await fixture.host.scanExtensions(installed);
    await fixture.host.startSession("references", [root], {
      storageRoot: join(root, "host-storage"),
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
      windowState: { focused: true, active: true },
      tabGroups: { groups: [{ id: "main", isActive: true, viewColumn: 1, tabs: [] }] },
    });
    await fixture.host.activateByEvent("references", "onCommand:typescript.tsserverRequest");
    await fixture.host.activateByEvent("references", "onCommand:references-view.find");
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await fixture.host.executeCommand(
              "references",
              "vscode.executeReferenceProvider",
              document.uri,
              caret,
            ),
          ),
        { timeout: 20_000 },
      )
      .toContain("lib.ts");
    await fixture.host.executeCommand("references", "references-view.findReferences");
    await expect(page.locator('[data-tree-view="references-view.tree"]')).toBeFocused();
    await expect(page.getByRole("button", { name: /main\.ts/ })).toBeVisible();
    const libraryNode = page.getByRole("button", { name: /lib\.ts/ });
    if ((await libraryNode.getAttribute("aria-expanded")) !== "true") await libraryNode.click();
    await page.getByRole("button", { name: /export const symbol/ }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
        ),
      )
      .toMatchObject({
        document: { uri: { path: library.uri.path } },
        selections: [{ active: { line: 0, character: 13 } }],
      });
    writeFileSync(
      join(root, "editor.json"),
      JSON.stringify(
        await page.evaluate(async () =>
          (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
        ),
        null,
        2,
      ),
    );
  } finally {
    await fixture.dispose("references");
    await page.evaluate(async () => {
      (await import("/tests/vscode-tree.fixture.ts")).closeTreeFixture();
      await (await import("/tests/vscode-builtin-editor.fixture.ts")).closeBuiltinEditor();
    });
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
