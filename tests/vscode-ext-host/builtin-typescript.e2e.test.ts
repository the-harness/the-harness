import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe.skipIf(
  !existsSync(join(extensionsDirectory, "typescript-language-features/package.json")),
)("official TypeScript built-in extension", () => {
  it("starts its bundled tsserver and provides diagnostics, completion and rename", async () => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "builtin-typescript-"));
    const installed = join(root, "extensions");
    mkdirSync(installed);
    cpSync(
      join(extensionsDirectory, "typescript-language-features"),
      join(installed, "typescript-language-features"),
      { recursive: true },
    );
    symlinkSync(join(extensionsDirectory, "node_modules"), join(installed, "node_modules"), "dir");
    const file = join(root, "main.ts");
    const content =
      "export const greeting: string = 42;\ngreeting.toUpperCase();\nexport function greet() { return greeting.toUpperCase(); }\nexport function caller() { return greet(); }\ncaller();\n";
    writeFileSync(file, content);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["*.ts"] }),
    );
    const document = new TextDocumentData({
      uri: Uri.file(file).toJSON(),
      text: content,
      version: 1,
      languageId: "typescript",
      isDirty: false,
      eol: 1,
    });
    const pasteFile = join(root, "paste.ts");
    writeFileSync(pasteFile, "export {};\n");
    const pasteDocument = new TextDocumentData({
      uri: Uri.file(pasteFile).toJSON(),
      text: "export {};\n",
      version: 1,
      languageId: "typescript",
      isDirty: false,
      eol: 1,
    });
    const editor = {
      document: document.toJSON(),
      selections: [new Selection(0, 0, 0, 0)],
      visibleRanges: [new Range(0, 0, 5, 0)],
      viewColumn: 1,
      options: { tabSize: 2, insertSpaces: true },
    };
    const fixture = await createBuiltinLanguageHost(root);
    const { host, registrations, diagnostics, errors, status } = fixture;
    const token = new CancellationTokenSource();
    try {
      await host.scanExtensions(installed);
      await host.startSession("builtin-typescript", [root], {
        storageRoot: join(root, "host-storage"),
        configuration: {
          defaults: {},
          user: {
            "telemetry.telemetryLevel": "off",
            "typescript.surveys.enabled": false,
            "js/ts.tsserver.useSyntaxServer": "never",
            "js/ts.tsserver.log": "verbose",
          },
          workspace: {},
        },
        documents: [document.toJSON(), pasteDocument.toJSON()],
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
                  id: "main.ts",
                  label: "main.ts",
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
      await host.activateByEvent("builtin-typescript", "onCommand:typescript.tsserverRequest");
      await vi.waitFor(
        () =>
          expect(
            registrations.some(
              ({ kind, metadata }) => kind === "CompletionItem" && metadata.includes("."),
            ) && registrations.some(({ kind }) => kind === "Rename"),
          ).toBe(true),
        { timeout: 30_000 },
      );
      expect(errors).toEqual([]);
      const completion = registrations.find(
        ({ kind, selector, metadata }) =>
          kind === "CompletionItem" &&
          metadata.includes(".") &&
          JSON.stringify(selector).includes("typescript"),
      )!;
      const result = await completion.provider.provideCompletionItems!(
        document,
        new Position(1, 9),
        token.token,
        { triggerKind: 1, triggerCharacter: "." },
      );
      writeFileSync(join(root, "completion.json"), JSON.stringify(result, null, 2));
      expect(JSON.stringify(result)).toContain("toUpperCase");
      const completionItems = (result as { items: { label: string | { label: string } }[] }).items;
      const upper = completionItems.find(
        (item) =>
          (typeof item.label === "string" ? item.label : item.label.label) === "toUpperCase",
      );
      expect(upper).toBeDefined();
      const resolved = await completion.provider.resolveCompletionItem!(upper, token.token);
      expect(JSON.stringify(resolved)).toContain("string");
      writeFileSync(join(root, "completion-resolved.json"), JSON.stringify(resolved, null, 2));
      const rename = registrations.find(
        ({ kind, selector }) =>
          kind === "Rename" && JSON.stringify(selector).includes("typescript"),
      )!;
      const renamed = await rename.provider.provideRenameEdits!(
        document,
        new Position(0, 15),
        "salutation",
        token.token,
      );
      writeFileSync(join(root, "rename.json"), JSON.stringify(renamed, null, 2));
      expect(renamed).toMatchObject({
        entries: [
          [
            expect.objectContaining({ path: file }),
            expect.arrayContaining([expect.objectContaining({ newText: "salutation" })]),
          ],
        ],
      });
      const highlight = await host.executeCommand(
        "builtin-typescript",
        "__languages.executeMultiDocumentHighlightProvider",
        document.uri,
        new Position(0, 15),
        [pasteDocument.uri],
      );
      expect(highlight).toMatchObject([
        expect.objectContaining({
          uri: expect.objectContaining({ path: file }),
          highlights: expect.arrayContaining([
            expect.objectContaining({ range: expect.anything() }),
          ]),
        }),
      ]);
      const copyStart = content.split("\n")[3]!.indexOf("greet");
      const paste = await host.executeCommand(
        "builtin-typescript",
        "__languages.executeDocumentPasteEditProvider",
        {
          source: {
            uri: document.uri,
            ranges: [new Range(3, copyStart, 3, copyStart + "greet()".length)],
          },
          target: { uri: pasteDocument.uri, ranges: [new Range(1, 0, 1, 0)] },
          text: "greet()",
        },
      );
      expect(paste).toMatchObject([
        expect.objectContaining({
          kind: { value: "text.updateImports.jsts" },
          additionalEdit: { entries: expect.any(Array) },
        }),
      ]);
      expect(JSON.stringify(paste)).toContain("./main");
      writeFileSync(
        join(root, "highlight-paste.json"),
        JSON.stringify({ highlight, paste }, null, 2),
      );
      const symbols = await host.executeCommand(
        "builtin-typescript",
        "vscode.executeWorkspaceSymbolProvider",
        "greet",
      );
      expect(JSON.stringify(symbols)).toContain("greet");
      const hierarchy = await host.executeCommand<unknown[]>(
        "builtin-typescript",
        "vscode.prepareCallHierarchy",
        document.uri,
        new Position(2, 18),
      );
      expect(hierarchy).toMatchObject([{ name: "greet" }]);
      const incoming = await host.executeCommand(
        "builtin-typescript",
        "vscode.provideIncomingCalls",
        hierarchy[0],
      );
      expect(incoming).toMatchObject([{ from: { name: "caller" } }]);
      const caller = await host.executeCommand<unknown[]>(
        "builtin-typescript",
        "vscode.prepareCallHierarchy",
        document.uri,
        new Position(3, 18),
      );
      const outgoing = await host.executeCommand(
        "builtin-typescript",
        "vscode.provideOutgoingCalls",
        caller[0],
      );
      expect(outgoing).toMatchObject([{ to: { name: "greet" } }]);
      writeFileSync(
        join(root, "symbols-hierarchy.json"),
        JSON.stringify({ symbols, hierarchy, incoming, outgoing }, null, 2),
      );
      expect([...status.values()]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            visible: true,
            tooltip: "TypeScript Version\nTypeScript version",
          }),
        ]),
      );
      await vi.waitFor(() => expect(JSON.stringify([...diagnostics.values()])).toContain("2322"), {
        timeout: 30_000,
      });
      writeFileSync(join(root, "diagnostics.json"), JSON.stringify([...diagnostics], null, 2));
      expect(errors).toEqual([]);
    } finally {
      token.dispose();
      await fixture.dispose("builtin-typescript");
      console.info(`TypeScript built-in artifacts: ${root}`);
    }
  }, 90_000);
});
