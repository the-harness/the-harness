import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CancellationTokenSource,
  TextDocumentData,
  Uri,
} from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

describe.skipIf(!existsSync(join(extensionsDirectory, "markdown-language-features/package.json")))(
  "official Markdown built-in extensions",
  () => {
    it.each([false, true])(
      "renders real Markdown and KaTeX through the official language extension (Mermaid=%s)",
      async (mermaid) => {
        const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
        mkdirSync(artifacts, { recursive: true });
        const root = mkdtempSync(join(artifacts, "builtin-markdown-"));
        const installed = join(root, "extensions");
        mkdirSync(installed);
        for (const name of [
          "markdown-language-features",
          "markdown-math",
          ...(mermaid ? ["mermaid-markdown-features"] : []),
        ]) {
          cpSync(join(extensionsDirectory, name), join(installed, name), { recursive: true });
        }
        const file = join(root, "readme.md");
        const source =
          "# Built-in smoke\n\n- first\n- second\n\n[Guide](guide.md)\n\n$x^2$\n\n$$x+1$$\n" +
          (mermaid ? "\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n" : "");
        writeFileSync(file, source);
        writeFileSync(join(root, "guide.md"), "# Guide\n");
        const document = new TextDocumentData({
          uri: Uri.file(file).toJSON(),
          text: source,
          version: 1,
          languageId: "markdown",
          eol: 1,
          isDirty: false,
        });
        const fixture = await createBuiltinLanguageHost(root);
        try {
          await fixture.host.scanExtensions(installed);
          await fixture.host.startSession("markdown", [root], {
            storageRoot: join(root, "host-storage"),
            configuration: {
              defaults: {},
              user: { "telemetry.telemetryLevel": "off" },
              workspace: {},
            },
            documents: [document.toJSON()],
            editors: { visible: [] },
            tabGroups: { groups: [{ id: "main", viewColumn: 1, isActive: true, tabs: [] }] },
            windowState: { focused: true, active: true },
          });
          await fixture.host.activateByEvent("markdown", "onLanguage:markdown");
          const html = await fixture.host.executeCommand<string>(
            "markdown",
            "markdown.api.render",
            source,
          );
          writeFileSync(join(root, "rendered.html"), html);
          expect(html).toContain("Built-in smoke");
          expect(html).toContain("guide.md");
          expect(html).toContain('class="katex"');
          expect(html).toContain('class="katex-display"');
          expect(html).toMatch(/<li\b[^>]*>first<\/li>/);
          await vi.waitFor(
            () =>
              expect(fixture.registrations.map((entry) => entry.kind)).toEqual(
                expect.arrayContaining(["DocumentLink", "DocumentSymbol"]),
              ),
            { timeout: 10_000 },
          );
          const token = new CancellationTokenSource();
          try {
            const links = (await fixture.registrations.find(
              (entry) => entry.kind === "DocumentLink",
            )!.provider.provideDocumentLinks!(document, token.token)) as {
              target?: Uri;
              range: unknown;
            }[] & { dispose?(): void };
            writeFileSync(join(root, "links.json"), JSON.stringify(links, null, 2));
            const linkProvider = fixture.registrations.find(
              (entry) => entry.kind === "DocumentLink",
            )!.provider;
            const link = (await linkProvider.resolveDocumentLink!(links[0], token.token)) as {
              target?: Uri;
              range: unknown;
            };
            writeFileSync(join(root, "resolved-link.json"), JSON.stringify(link, null, 2));
            expect(link?.target?.path).toBe(join(root, "guide.md"));
            expect(link?.range).toMatchObject({ start: { line: 5, character: 8 } });
            const symbols = await fixture.registrations.find(
              (entry) => entry.kind === "DocumentSymbol",
            )!.provider.provideDocumentSymbols!(document, token.token);
            expect(symbols).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  name: "# Built-in smoke",
                  selectionRange: expect.objectContaining({ start: { line: 0, character: 0 } }),
                }),
              ]),
            );
            writeFileSync(
              join(root, "language-results.json"),
              JSON.stringify({ links, symbols }, null, 2),
            );
            expect(links.dispose).toBeTypeOf("function");
            links.dispose!();
            expect(await linkProvider.resolveDocumentLink!(links[0], token.token)).toBeUndefined();
          } finally {
            token.dispose();
          }
          if (mermaid) expect(html).toContain('<pre class="mermaid" style="all: unset;">');
          await fixture.host.executeCommand("markdown", "__config.sync", {
            defaults: {},
            user: { "markdown.math.enabled": false },
            workspace: {},
          });
          const plain = await fixture.host.executeCommand<string>(
            "markdown",
            "markdown.api.render",
            source,
          );
          expect(plain).not.toContain('class="katex"');
          expect(plain).toContain("$x^2$");
          expect(fixture.errors).toEqual([]);
        } finally {
          await fixture.dispose("markdown");
          console.info(`Markdown built-in artifacts: ${root}`);
        }
      },
      60_000,
    );
  },
);
