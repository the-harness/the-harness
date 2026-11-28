import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CancellationTokenSource,
  Range,
  Selection,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
const scenarios = [
  {
    language: "html",
    extension: "html-language-features",
    text: '<html>\n<head><style>.x{color: ;}</style></head>\n<body><div>hello</div><a href="./target.html">target</a><script>const count=1; count;</script></body>\n</html>',
    completeAt: "<div",
    hoverAt: "div",
    expectedCompletion: "div",
    expectedHover: "element",
    expectedDiagnostic: "property value",
    configuration: {},
  },
  {
    language: "handlebars",
    extension: "html-language-features",
    text: '<html>\n<head><style>.x{color: ;}</style></head>\n<body><div>{{title}}</div><a href="./target.html">target</a><script>const count=1; count;</script></body>\n</html>',
    completeAt: "<div",
    hoverAt: "div",
    expectedCompletion: "div",
    expectedHover: "element",
    expectedDiagnostic: "property value",
    configuration: {},
  },
  {
    language: "css",
    extension: "css-language-features",
    text: "a{colr:red;color: red;}",
    completeAt: "col",
    hoverAt: "color",
    expectedCompletion: "color",
    expectedHover: "color",
    expectedDiagnostic: "Unknown property",
    configuration: {},
  },
  {
    language: "json",
    extension: "json-language-features",
    text: '{"name":42,"":true}',
    completeAt: ',"',
    hoverAt: "name",
    expectedCompletion: "enabled",
    expectedHover: "A human readable name",
    expectedDiagnostic: "string",
    configuration: {
      "json.schemas": [
        {
          fileMatch: ["main.json"],
          schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "A human readable name" },
              enabled: { type: "boolean", description: "Whether enabled" },
            },
          },
        },
      ],
    },
  },
];

describe("official web language built-in extensions", () => {
  for (const scenario of scenarios) {
    it.skipIf(!existsSync(join(extensionsDirectory, scenario.extension, "package.json")))(
      scenario.language === "handlebars"
        ? "HTML participant contribution enables Handlebars completion, hover and formatting"
        : `${scenario.language} server provides diagnostics, completion, hover and formatting`,
      async () => {
        const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
        mkdirSync(artifacts, { recursive: true });
        const root = mkdtempSync(join(artifacts, `builtin-${scenario.language}-`));
        const installed = join(root, "extensions");
        mkdirSync(installed);
        for (const name of scenario.extension === "html-language-features"
          ? [
              scenario.extension,
              "css-language-features",
              "typescript-language-features",
              "handlebars",
            ]
          : [scenario.extension]) {
          cpSync(join(extensionsDirectory, name), join(installed, name), { recursive: true });
        }
        symlinkSync(
          join(extensionsDirectory, "node_modules"),
          join(installed, "node_modules"),
          "dir",
        );
        const file = join(root, `main.${scenario.language}`);
        writeFileSync(file, scenario.text);
        if (scenario.extension === "html-language-features")
          writeFileSync(join(root, "target.html"), "<p>target</p>");
        const document = new TextDocumentData({
          uri: Uri.file(file).toJSON(),
          text: scenario.text,
          version: 1,
          languageId: scenario.language,
          isDirty: false,
          eol: 1,
        });
        const editor = {
          document: document.toJSON(),
          selections: [new Selection(0, 0, 0, 0)],
          visibleRanges: [
            new Range(document.positionAt(0), document.positionAt(scenario.text.length)),
          ],
          viewColumn: 1,
          options: { tabSize: 2, insertSpaces: true },
        };
        const fixture = await createBuiltinLanguageHost(root);
        const { host, registrations, diagnostics, errors } = fixture;
        const session = `builtin-${scenario.language}`;
        const token = new CancellationTokenSource();
        try {
          await host.scanExtensions(installed);
          await host.startSession(session, [root], {
            storageRoot: join(root, "host-storage"),
            configuration: {
              defaults: {},
              user: { "telemetry.telemetryLevel": "off", ...scenario.configuration },
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
                      label: `main.${scenario.language}`,
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
          await host.activateByEvent(session, `onLanguage:${scenario.language}`);
          await vi.waitFor(
            () => {
              expect(errors).toEqual([]);
              expect(registrations.map(({ kind }) => kind)).toEqual(
                expect.arrayContaining(["CompletionItem", "Hover"]),
              );
            },
            { timeout: 20_000 },
          );
          const provider = (kind: string) =>
            registrations.find(
              (registration) =>
                registration.kind === kind &&
                JSON.stringify(registration.selector).includes(scenario.language),
            )!.provider;
          const completionOffset =
            scenario.text.indexOf(scenario.completeAt) + scenario.completeAt.length;
          const completion = await provider("CompletionItem").provideCompletionItems!(
            document,
            document.positionAt(completionOffset),
            token.token,
            { triggerKind: 0 },
          );
          writeFileSync(join(root, "completion.json"), JSON.stringify(completion, null, 2));
          expect(JSON.stringify(completion)).toContain(scenario.expectedCompletion);
          const items = (completion as { items: { label: string | { label: string } }[] }).items;
          const item = items.find(
            (entry) =>
              (typeof entry.label === "string" ? entry.label : entry.label.label) ===
              scenario.expectedCompletion,
          );
          expect(item).toBeDefined();
          if (provider("CompletionItem").resolveCompletionItem) {
            const resolved = await provider("CompletionItem").resolveCompletionItem!(
              item,
              token.token,
            );
            expect(resolved).toMatchObject({ label: scenario.expectedCompletion });
            writeFileSync(
              join(root, "completion-resolved.json"),
              JSON.stringify(resolved, null, 2),
            );
          }
          const hover = await provider("Hover").provideHover!(
            document,
            document.positionAt(scenario.text.indexOf(scenario.hoverAt) + 1),
            token.token,
          );
          writeFileSync(join(root, "hover.json"), JSON.stringify(hover, null, 2));
          expect(JSON.stringify(hover)).toContain(scenario.expectedHover);
          await vi.waitFor(
            () =>
              expect(
                registrations.some(
                  ({ kind }) =>
                    kind === "DocumentFormattingEdit" || kind === "DocumentRangeFormattingEdit",
                ),
              ).toBe(true),
            { timeout: 10_000 },
          );
          const format = registrations.some(({ kind }) => kind === "DocumentFormattingEdit")
            ? await provider("DocumentFormattingEdit").provideDocumentFormattingEdits!(
                document,
                { tabSize: 2, insertSpaces: true },
                token.token,
              )
            : await provider("DocumentRangeFormattingEdit").provideDocumentRangeFormattingEdits!(
                document,
                new Range(document.positionAt(0), document.positionAt(scenario.text.length)),
                { tabSize: 2, insertSpaces: true },
                token.token,
              );
          writeFileSync(join(root, "format.json"), JSON.stringify(format, null, 2));
          expect(format).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ range: expect.anything(), newText: expect.any(String) }),
            ]),
          );
          if (scenario.language === "handlebars") {
            (completion as { dispose?: () => void }).dispose?.();
            expect(errors).toEqual([]);
            return;
          }
          await vi.waitFor(
            () => {
              expect(errors).toEqual([]);
              expect(JSON.stringify([...diagnostics.values()])).toContain(
                scenario.expectedDiagnostic,
              );
            },
            { timeout: 20_000 },
          );
          writeFileSync(join(root, "diagnostics.json"), JSON.stringify([...diagnostics], null, 2));
          if (scenario.extension === "html-language-features") {
            await vi.waitFor(
              () =>
                expect(registrations.some(({ kind }) => kind === "DocumentSemanticTokens")).toBe(
                  true,
                ),
              { timeout: 10_000 },
            );
            const semanticTokens = await provider("DocumentSemanticTokens")
              .provideDocumentSemanticTokens!(document, token.token);
            expect(semanticTokens).toMatchObject({ data: expect.any(Array) });
            expect((semanticTokens as { data: unknown[] }).data.length).toBeGreaterThan(0);
            writeFileSync(
              join(root, "semantic-tokens.json"),
              JSON.stringify(semanticTokens, null, 2),
            );
            const links = await provider("DocumentLink").provideDocumentLinks!(
              document,
              token.token,
            );
            expect(links).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  target: expect.objectContaining({ path: join(root, "target.html") }),
                }),
              ]),
            );
            writeFileSync(join(root, "links.json"), JSON.stringify(links, null, 2));
          } else if (scenario.language === "css") {
            const colors = await provider("Color").provideDocumentColors!(document, token.token);
            expect(colors).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ color: { red: 1, green: 0, blue: 0, alpha: 1 } }),
              ]),
            );
            writeFileSync(join(root, "colors.json"), JSON.stringify(colors, null, 2));
          } else {
            const before = document.getText();
            const after = before.replace('"name":42', '"name":"valid"');
            const range = new Range(document.positionAt(0), document.positionAt(before.length));
            document.update({ ...document.toJSON(), text: after, version: 2, isDirty: true });
            await host.executeCommand(session, "__ws.onDidChangeTextDocument", {
              document: document.toJSON(),
              contentChanges: [{ range, rangeOffset: 0, rangeLength: before.length, text: after }],
            });
            await vi.waitFor(() => expect([...diagnostics.values()].flat()).toEqual([]), {
              timeout: 20_000,
            });
            writeFileSync(
              join(root, "diagnostics-after-edit.json"),
              JSON.stringify([...diagnostics], null, 2),
            );
          }
          (completion as { dispose?: () => void })?.dispose?.();
          expect(errors).toEqual([]);
        } finally {
          token.dispose();
          await fixture.dispose(session);
          console.info(`${scenario.language} built-in artifacts: ${root}`);
        }
      },
      60_000,
    );
  }
});
