import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  Selection,
  Range,
  TextDocumentData,
  Uri,
  CancellationTokenSource,
} from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

test("official extension editing completes language override keys from the real Monaco registry", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "extension-editing/package.json")),
    "Official desktop extension-editing bundle is not installed",
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-extension-editing-monaco-"));
  const installed = join(root, "extensions");
  mkdirSync(installed);
  cpSync(join(extensionsDirectory, "extension-editing"), join(installed, "extension-editing"), {
    recursive: true,
  });
  symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
  const abbreviation =
    '{"name":"fixture","version":"1.0.0","engines":{"vscode":"*"},"contributes":{"configurationDefaults":{"[":{}}}}';
  const file = join(root, "package.json");
  writeFileSync(file, abbreviation);
  const document = new TextDocumentData({
    uri: Uri.file(file).toJSON(),
    text: abbreviation,
    languageId: "json",
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
    if (!method.startsWith("editor.") && method !== "languages.getLanguages")
      return { handled: false };
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
    await fixture.host.startSession("extension-editing", [root], {
      storageRoot: join(root, "host-storage"),
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
    });
    await fixture.host.activateByEvent("extension-editing", "onLanguage:json");
    await expect
      .poll(() => fixture.registrations.some(({ kind }) => kind === "CompletionItem"))
      .toBe(true);
    const provider = fixture.registrations.find(({ kind }) => kind === "CompletionItem")!.provider;
    const token = new CancellationTokenSource();
    const completions = (await provider.provideCompletionItems!(
      document,
      document.positionAt(abbreviation.indexOf('"["') + 2),
      token.token,
      { triggerKind: 0 },
    )) as { items: { label: string; range: Range; insertText: string }[]; dispose?(): void };
    token.dispose();
    const item = completions.items.find(({ label }) => label === "typescript");
    expect(item).toBeDefined();
    writeFileSync(join(root, "completion.json"), JSON.stringify(item, null, 2));
    await page.evaluate(
      async ({ uri, item }) =>
        (await import("/tests/vscode-builtin-editor.fixture.ts")).dispatchBuiltinEditor(
          "extension-editing",
          "editor.edit",
          [uri, 1, [{ range: item.range, text: item.insertText }], undefined, {}],
        ),
      { uri: document.uri.toJSON(), item: item! },
    );
    const edited = (await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
    )) as { text: string };
    expect(JSON.parse(edited.text).contributes.configurationDefaults).toEqual({
      "[typescript]": {},
    });
    completions.dispose?.();
    const result = await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
    );
    writeFileSync(join(root, "editor.json"), JSON.stringify(result, null, 2));
  } finally {
    await fixture.dispose("extension-editing");
    await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).closeBuiltinEditor(),
    );
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
