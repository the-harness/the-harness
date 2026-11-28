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

test("official merge-conflict CodeLens accepts the current change through the real worker and Monaco editor", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "merge-conflict/package.json")),
    "Official desktop merge-conflict bundle is not installed",
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-merge-conflict-monaco-"));
  const installed = join(root, "extensions");
  mkdirSync(installed);
  cpSync(join(extensionsDirectory, "merge-conflict"), join(installed, "merge-conflict"), {
    recursive: true,
  });
  symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
  const abbreviation = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n";
  const file = join(root, "conflict.txt");
  writeFileSync(file, abbreviation);
  const document = new TextDocumentData({
    uri: Uri.file(file).toJSON(),
    text: abbreviation,
    languageId: "plaintext",
    version: 1,
    isDirty: false,
    eol: 1,
  });
  const caret = document.positionAt(0);
  const editor = {
    document: document.toJSON(),
    selections: [new Selection(caret, caret)],
    visibleRanges: [new Range(document.positionAt(0), document.positionAt(abbreviation.length))],
    viewColumn: 1,
    options: { tabSize: 2, insertSpaces: true },
  };
  await page.goto("/");
  await page.evaluate(
    async ({ snapshot, offset }) => {
      const fixture = await import("/tests/vscode-builtin-editor.fixture.ts");
      fixture.openBuiltinEditor(snapshot, offset);
    },
    { snapshot: document.toJSON(), offset: 0 },
  );
  const fixture = await createBuiltinLanguageHost(root, async (session, method, args) => {
    if (!method.startsWith("editor.") || method === "editor.setDecorations")
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
    await fixture.host.startSession("merge-conflict", [root], {
      storageRoot: join(root, "host-storage"),
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
    });
    await fixture.host.activateByEvent("merge-conflict", "onStartupFinished");
    await expect
      .poll(() => fixture.registrations.some(({ kind }) => kind === "CodeLens"))
      .toBe(true);
    const provider = fixture.registrations.find(({ kind }) => kind === "CodeLens")!.provider;
    const token = new CancellationTokenSource();
    const lenses = (await provider.provideCodeLenses!(document, token.token)) as {
      range: Range;
      command: { title: string; command: string; arguments: unknown[] };
    }[] & { dispose?(): void };
    token.dispose();
    expect(lenses).toHaveLength(4);
    expect(lenses[0]!.range).toMatchObject({ start: { line: 0, character: 0 } });
    writeFileSync(join(root, "code-lenses.json"), JSON.stringify(lenses, null, 2));
    const accept = lenses.find(({ command }) => command.title === "Accept Current Change")!;
    await fixture.host.executeCommand(
      "merge-conflict",
      accept.command.command,
      ...accept.command.arguments,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(async () =>
            (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
          ),
        { timeout: 10_000 },
      )
      .toMatchObject({ text: "ours\n" });
    lenses.dispose?.();
    expect(
      await fixture.host.executeCommand(
        "merge-conflict",
        accept.command.command,
        ...accept.command.arguments,
      ),
    ).toBeUndefined();
    const result = await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).observeBuiltinEditor(),
    );
    writeFileSync(join(root, "editor.json"), JSON.stringify(result, null, 2));
  } finally {
    await fixture.dispose("merge-conflict");
    await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-editor.fixture.ts")).closeBuiltinEditor(),
    );
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
