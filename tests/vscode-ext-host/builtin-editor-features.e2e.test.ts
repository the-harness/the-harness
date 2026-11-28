import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CancellationTokenSource,
  Position,
  Range,
  Selection,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

async function startBuiltin(
  name: string,
  relativeFile: string,
  text: string,
  languageId: string,
  offset = 0,
  extraExtensions: string[] = [],
  configuration: Record<string, unknown> = {},
) {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, `builtin-${name}-`));
  const installed = join(root, "extensions");
  mkdirSync(installed);
  for (const extension of [name, ...extraExtensions])
    cpSync(join(extensionsDirectory, extension), join(installed, extension), { recursive: true });
  symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
  const file = join(root, relativeFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const document = new TextDocumentData({
    uri: Uri.file(file).toJSON(),
    text,
    version: 1,
    languageId,
    isDirty: false,
    eol: 1,
  });
  const caret = document.positionAt(offset);
  const editor = {
    document: document.toJSON(),
    selections: [new Selection(caret, caret)],
    visibleRanges: [new Range(document.positionAt(0), document.positionAt(text.length))],
    viewColumn: 1,
    options: { tabSize: 2, insertSpaces: true },
  };
  const fixture = await createBuiltinLanguageHost(root);
  try {
    await fixture.host.scanExtensions(installed);
    await fixture.host.startSession(name, [root], {
      storageRoot: join(root, "host-storage"),
      configuration: {
        defaults: {},
        user: { "telemetry.telemetryLevel": "off", ...configuration },
        workspace: {},
      },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
      environment: { language: "en" },
      windowState: { focused: true, active: true },
      tabGroups: {
        groups: [
          {
            id: "main",
            isActive: true,
            viewColumn: 1,
            tabs: [
              {
                id: "main",
                label: relativeFile,
                input: { kind: "text", uri: document.uri.toJSON() },
                isActive: true,
                isDirty: false,
                isPinned: true,
                isPreview: false,
              },
            ],
          },
        ],
      },
    });
    return {
      ...fixture,
      root,
      document,
      session: name,
      async close() {
        await fixture.dispose(name);
        console.info(`${name} artifacts: ${root}`);
      },
    };
  } catch (error) {
    await fixture.dispose(name);
    throw error;
  }
}

describe("official editor feature built-in extensions", () => {
  it.skipIf(!existsSync(join(extensionsDirectory, "configuration-editing/package.json")))(
    "configuration editing completes workspace variables with the correct replacement range",
    async () => {
      const content = '{"configurations":[{"program":"${wor}"}]}';
      const fixture = await startBuiltin(
        "configuration-editing",
        ".vscode/launch.json",
        content,
        "jsonc",
      );
      const token = new CancellationTokenSource();
      try {
        await fixture.host.activateByEvent(fixture.session, "onLanguage:jsonc");
        await vi.waitFor(() =>
          expect(
            fixture.registrations.some(
              ({ kind, selector }) =>
                kind === "CompletionItem" && JSON.stringify(selector).includes("launch.json"),
            ),
          ).toBe(true),
        );
        const provider = fixture.registrations.find(
          ({ kind, selector }) =>
            kind === "CompletionItem" && JSON.stringify(selector).includes("launch.json"),
        )!.provider;
        const result = (await provider.provideCompletionItems!(
          fixture.document,
          fixture.document.positionAt(content.indexOf("wor") + 3),
          token.token,
          { triggerKind: 0 },
        )) as {
          items: { label: string; insertText: string; range: Range }[];
          dispose?: () => void;
        };
        const item = result.items.find(({ label }) => label === "${workspaceFolder}");
        expect(item).toBeDefined();
        const edited =
          content.slice(0, fixture.document.offsetAt(item!.range.start)) +
          item!.insertText +
          content.slice(fixture.document.offsetAt(item!.range.end));
        expect(JSON.parse(edited).configurations[0].program).toBe("${workspaceFolder}");
        writeFileSync(
          join(fixture.root, "completion.json"),
          JSON.stringify({ item, edited }, null, 2),
        );
        result.dispose?.();
        expect(fixture.errors).toEqual([]);
      } finally {
        token.dispose();
        await fixture.close();
      }
    },
    30_000,
  );

  it.skipIf(!existsSync(join(extensionsDirectory, "search-result/package.json")))(
    "search-result definitions, links and symbols identify the real target file and line",
    async () => {
      const content = "src/main.ts:\n  2: needle\n";
      const fixture = await startBuiltin(
        "search-result",
        "result.code-search",
        content,
        "search-result",
      );
      mkdirSync(join(fixture.root, "src"));
      writeFileSync(join(fixture.root, "src/main.ts"), "first\nneedle\n");
      const token = new CancellationTokenSource();
      try {
        await fixture.host.activateByEvent(fixture.session, "onLanguage:search-result");
        const provider = (kind: string) =>
          fixture.registrations.find((entry) => entry.kind === kind)!.provider;
        const definition = await provider("Definition").provideDefinition!(
          fixture.document,
          new Position(1, 5),
          token.token,
        );
        const links = await provider("DocumentLink").provideDocumentLinks!(
          fixture.document,
          token.token,
        );
        const symbols = await provider("DocumentSymbol").provideDocumentSymbols!(
          fixture.document,
          token.token,
        );
        const path = join(fixture.root, "src/main.ts");
        expect(definition).toMatchObject([
          { targetUri: { path }, targetSelectionRange: { start: { line: 1, character: 0 } } },
        ]);
        expect(links).toMatchObject([{ target: { path } }]);
        expect(symbols).toMatchObject([{ name: "src/main.ts", kind: 0 }]);
        writeFileSync(
          join(fixture.root, "providers.json"),
          JSON.stringify({ definition, links, symbols }, null, 2),
        );
        expect(fixture.errors).toEqual([]);
      } finally {
        token.dispose();
        await fixture.close();
      }
    },
    30_000,
  );
  it.skipIf(!existsSync(join(extensionsDirectory, "references-view/package.json")))(
    "references view groups actual TypeScript references from two files",
    async () => {
      const content = 'import { symbol } from "./lib";\nconsole.log(symbol);\n';
      const fixture = await startBuiltin(
        "references-view",
        "main.ts",
        content,
        "typescript",
        content.lastIndexOf("symbol"),
        ["typescript-language-features"],
      );
      writeFileSync(join(fixture.root, "lib.ts"), "export const symbol = 42;\n");
      writeFileSync(
        join(fixture.root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", strict: true }, include: ["*.ts"] }),
      );
      try {
        await fixture.host.activateByEvent(fixture.session, "onCommand:typescript.tsserverRequest");
        await fixture.host.activateByEvent(fixture.session, "onCommand:references-view.find");
        await vi.waitFor(
          () => expect(fixture.registrations.some(({ kind }) => kind === "Reference")).toBe(true),
          { timeout: 20_000 },
        );
        await vi.waitFor(
          async () => {
            const locations = await fixture.host.executeCommand(
              fixture.session,
              "vscode.executeReferenceProvider",
              fixture.document.uri,
              fixture.document.positionAt(content.lastIndexOf("symbol")),
            );
            expect(JSON.stringify(locations)).toContain("lib.ts");
            writeFileSync(
              join(fixture.root, "references.json"),
              JSON.stringify(locations, null, 2),
            );
          },
          { timeout: 20_000 },
        );
        await fixture.host.executeCommand(fixture.session, "references-view.findReferences");
        await vi.waitFor(
          async () => {
            expect(fixture.errors).toEqual([]);
            const groups = await fixture.host.executeCommand(
              fixture.session,
              "__tree.getChildren.references-view.tree",
            );
            expect(JSON.stringify(groups)).toContain("lib.ts");
            expect(JSON.stringify(groups)).toContain("main.ts");
            writeFileSync(join(fixture.root, "tree.json"), JSON.stringify(groups, null, 2));
          },
          { timeout: 20_000 },
        );
      } finally {
        await fixture.close();
      }
    },
    45_000,
  );

  it.skipIf(!existsSync(join(extensionsDirectory, "php-language-features/package.json")))(
    "PHP provides completion and hover and reports its validator availability",
    async () => {
      const content = "<?php\nstrlen('hello');\nstr";
      const executable = process.env.HARNESS_PHP_EXECUTABLE
        ? resolve(process.env.HARNESS_PHP_EXECUTABLE)
        : undefined;
      const php = spawnSync(executable ?? "php", ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (executable) expect(php.status, php.error?.message ?? php.stderr).toBe(0);
      const fixture = await startBuiltin(
        "php-language-features",
        "main.php",
        content,
        "php",
        0,
        [],
        {
          "php.validate.run": "onType",
          ...(executable ? { "php.validate.executablePath": executable } : {}),
        },
      );
      const token = new CancellationTokenSource();
      try {
        await fixture.host.activateByEvent(fixture.session, "onLanguage:php");
        const provider = (kind: string) =>
          fixture.registrations.find((entry) => entry.kind === kind)!.provider;
        const completion = (await provider("CompletionItem").provideCompletionItems!(
          fixture.document,
          new Position(2, 3),
          token.token,
          { triggerKind: 0 },
        )) as { items: { label: string }[]; dispose?(): void };
        expect(completion.items).toContainEqual(expect.objectContaining({ label: "strlen" }));
        const hover = await provider("Hover").provideHover!(
          fixture.document,
          new Position(1, 3),
          token.token,
        );
        expect(JSON.stringify(hover)).toContain("strlen");
        expect(JSON.stringify(hover)).toContain("length");
        writeFileSync(
          join(fixture.root, "providers.json"),
          JSON.stringify({ completion, hover }, null, 2),
        );
        if (php.status === 0) {
          await vi.waitFor(
            () =>
              expect([...fixture.diagnostics.values()].flat()).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    message: expect.stringMatching(/syntax error/i),
                    range: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }),
                  }),
                ]),
              ),
            { timeout: 10_000 },
          );
          const diagnostics = [...fixture.diagnostics];
          const corrected = "<?php\nstrlen('hello');\n";
          const range = new Range(
            fixture.document.positionAt(0),
            fixture.document.positionAt(content.length),
          );
          fixture.document.update({
            ...fixture.document.toJSON(),
            text: corrected,
            version: 2,
            isDirty: true,
          });
          await fixture.host.executeCommand(fixture.session, "__ws.onDidChangeTextDocument", {
            document: fixture.document.toJSON(),
            contentChanges: [
              { range, rangeOffset: 0, rangeLength: content.length, text: corrected },
            ],
          });
          await vi.waitFor(() => expect([...fixture.diagnostics.values()].flat()).toEqual([]), {
            timeout: 10_000,
          });
          expect(readFileSync(fixture.document.uri.fsPath, "utf8")).toBe(content);
          writeFileSync(
            join(fixture.root, "validator.json"),
            JSON.stringify(
              {
                status: "passed",
                executable: executable ?? "php (PATH)",
                version: php.stdout,
                mode: "onType / php -l stdin",
                diagnostics,
                afterUnsavedCorrection: [...fixture.diagnostics],
                diskStillContainsInvalidSource: true,
              },
              null,
              2,
            ),
          );
        } else {
          await vi.waitFor(
            () => {
              const messages = readFileSync(join(fixture.root, "messages.jsonl"), "utf8");
              expect(messages).toContain("PHP installation could not be found");
            },
            { timeout: 10_000 },
          );
          writeFileSync(
            join(fixture.root, "validator.json"),
            JSON.stringify(
              {
                status: "blocked-environment",
                reason: "No PHP executable is installed on PATH",
                completion: "passed",
                hover: "passed",
              },
              null,
              2,
            ),
          );
        }
        completion.dispose?.();
        expect(fixture.errors).toEqual([]);
      } finally {
        token.dispose();
        await fixture.close();
      }
    },
    30_000,
  );
});
