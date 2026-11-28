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

test("official Emmet expands nested repeated elements through the real worker and Monaco snippet controller", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "emmet/package.json")),
    "Official desktop Emmet bundle is not installed",
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-emmet-monaco-"));
  const installed = join(root, "extensions");
  mkdirSync(installed);
  cpSync(join(extensionsDirectory, "emmet"), join(installed, "emmet"), { recursive: true });
  symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
  const abbreviation = "ul>li.item*2";
  const file = join(root, "main.html");
  writeFileSync(file, abbreviation);
  const document = new TextDocumentData({
    uri: Uri.file(file).toJSON(),
    text: abbreviation,
    languageId: "html",
    version: 1,
    isDirty: false,
    eol: 1,
  });
  const caret = document.positionAt(abbreviation.length);
  const editor = {
    document: document.toJSON(),
    selections: [new Selection(caret, caret)],
    visibleRanges: [new Range(0, 0, 0, abbreviation.length)],
    viewColumn: 1,
    options: { tabSize: 2, insertSpaces: true },
  };
  await page.goto("/");
  await page.evaluate(
    async ({ snapshot, offset }) => {
      const fixture = await import("/tests/vscode-builtin-editor.fixture.ts");
      fixture.openBuiltinEditor(snapshot, offset);
    },
    { snapshot: document.toJSON(), offset: abbreviation.length },
  );
  const fixture = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("editor.")) return { handled: false };
    return {
      handled: true,
      result: await page.evaluate(
        async ({ session, method, args }) => {
          const fixture = await import("/tests/vscode-builtin-editor.fixture.ts");
          return fixture.dispatchBuiltinEditor(session, method, args);
        },
        { session, method, args },
      ),
    };
  });
  try {
    await fixture.host.scanExtensions(installed);
    await fixture.host.startSession("emmet", [root], {
      storageRoot: join(root, "host-storage"),
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
    });
    await fixture.host.activateByEvent("emmet", "onLanguage:html");
    await expect
      .poll(() =>
        fixture.registrations.some(
          ({ kind, selector }) =>
            kind === "CompletionItem" && (selector as { language?: string })?.language === "html",
        ),
      )
      .toBe(true);
    await fixture.host.executeCommand("emmet", "emmet.expandAbbreviation");
    await expect
      .poll(
        async () =>
          page.evaluate(async () =>
            (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
          ),
        { timeout: 10_000 },
      )
      .toMatchObject({
        text: '<ul>\n  <li class="item"></li>\n  <li class="item"></li>\n</ul>',
        inSnippet: true,
      });
    const result = await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
    );
    writeFileSync(join(root, "editor.json"), JSON.stringify(result, null, 2));
  } finally {
    await fixture.dispose("emmet");
    await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).closeBuiltinEditor(),
    );
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
