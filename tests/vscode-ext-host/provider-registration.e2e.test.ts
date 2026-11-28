import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createMainThreadLanguages } from "../../packages/vscode-ext-host/src/main-thread/languages.ts";

vi.mock("@harness/vscode-editor-compat", async () => ({
  ...(await import("../../packages/vscode-ext-host/src/vscode/types.ts")),
  ...(await import("../../packages/vscode-ext-host/src/vscode/languages.ts")),
}));

const providers = [
  ["registerInlineCompletionItemProvider", "provideInlineCompletionItems"],
  ["registerCodeActionsProvider", "provideCodeActions"],
  ["registerFoldingRangeProvider", "provideFoldingRanges"],
  ["registerDocumentSymbolProvider", "provideDocumentSymbols"],
  ["registerDocumentFormattingEditProvider", "provideDocumentFormattingEdits"],
  ["registerReferenceProvider", "provideReferences"],
  ["registerRenameProvider", "provideRenameEdits"],
  ["registerSignatureHelpProvider", "provideSignatureHelp"],
  ["registerDocumentHighlightProvider", "provideDocumentHighlights"],
  ["registerDocumentLinkProvider", "provideDocumentLinks"],
  ["registerColorProvider", "provideDocumentColors"],
  ["registerInlayHintsProvider", "provideInlayHints"],
  ["registerCodeLensProvider", "provideCodeLenses"],
  ["registerDocumentRangeFormattingEditProvider", "provideDocumentRangeFormattingEdits"],
] as const;

describe("extension language provider registration", () => {
  it("registers and disposes all existing provider kinds across the real worker bridge", async () => {
    const artifacts = join(process.cwd(), "temp/artifacts");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "provider-registration-"));
    const extensionDir = join(root, "extensions/demo");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, "package.json"),
      JSON.stringify({
        publisher: "regression",
        name: "language-registration",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:registration.start"],
      }),
    );
    writeFileSync(
      join(extensionDir, "extension.cjs"),
      `
      const vscode = require('vscode');
      exports.activate = () => {
        const registrations = ${JSON.stringify(providers)}.map(([register, provide]) =>
          vscode.languages[register]('typescript', { [provide]() { return []; } }, '('));
        vscode.commands.registerCommand('registration.start', () => registrations.length);
        vscode.commands.registerCommand('registration.dispose', () => {
          for (const registration of registrations) registration.dispose();
        });
      };
    `,
    );
    const registrations: { name: string; selector: unknown; triggers: unknown[] }[] = [];
    const disposed: string[] = [];
    const languageService = Object.fromEntries(
      providers.map(([name]) => [
        name,
        (selector: unknown, _provider: unknown, ...triggers: unknown[]) => {
          registrations.push({ name, selector, triggers });
          return {
            dispose: () => {
              disposed.push(name);
            },
          };
        },
      ]),
    );
    const hostFixture = await createExtensionHostFixture();
    const service = hostFixture.service;
    const handler = createMainThreadLanguages(
      languageService as never,
      (sessionId, command, args) => service.executeCommand(sessionId, command, ...args),
    );
    const errors: string[] = [];
    const requests = new Set<Promise<void>>();
    const off = service.onMainThreadCall((sessionId, method, args, requestId) => {
      const request = Promise.resolve()
        .then(() => {
          if (method.startsWith("languages.")) handler(sessionId, method, args);
          service.resolveMainCall(requestId, undefined);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          service.resolveMainCall(requestId, undefined, message);
        });
      requests.add(request);
      void request.finally(() => requests.delete(request));
      return request;
    });
    try {
      await service.scanExtensions(join(root, "extensions"));
      await service.startSession("provider-registration", [root]);
      expect(await service.executeCommand("provider-registration", "registration.start")).toBe(14);
      await vi.waitFor(() => expect(registrations).toHaveLength(14));
      expect(errors).toEqual([]);
      expect(registrations.map(({ name }) => name).sort()).toEqual(
        providers.map(([name]) => name).sort(),
      );
      expect(registrations.every(({ selector }) => selector === "typescript")).toBe(true);
      expect(
        registrations.find(({ name }) => name === "registerSignatureHelpProvider")?.triggers,
      ).toEqual([{ triggerCharacters: ["("] }]);
      await service.executeCommand("provider-registration", "registration.dispose");
      await vi.waitFor(() => expect(disposed).toHaveLength(14));
      expect(new Set(disposed).size).toBe(14);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(requests);
      await hostFixture.dispose("provider-registration");
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
