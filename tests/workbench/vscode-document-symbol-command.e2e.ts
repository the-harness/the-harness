import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("executes document symbol providers through Monaco and returns both symbol shapes", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-document-symbol-command-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "symbols");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "symbols",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  writeFileSync(
    join(extension, "index.cjs"),
    String.raw`
const vscode = require("vscode");

exports.activate = context => {
  const runtimeFile = vscode.workspace.textDocuments[0];
  const childrenRange = new vscode.Range(0, 0, 0, 5);
  const parentRange = new vscode.Range(0, 0, 1, 6);
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      { language: "plaintext", scheme: "file", pattern: "**/*.fixture" },
      {
        provideDocumentSymbols(document, token) {
          if (token.isCancellationRequested || document.getText() !== "outer inner\nsecond")
            throw new Error("Provider did not receive the working copy");
          const title = document === runtimeFile ? "current" : "unopened";
          const make = (name, range, containerName) => new vscode.SymbolInformation(
            name, vscode.SymbolKind.Function, containerName, new vscode.Location(document.uri, range),
          );
          return [
            make("child", childrenRange, title),
            make(title, parentRange, "file-scope"),
            make("sibling", childrenRange, title),
          ];
        },
      },
    ),
    vscode.workspace.registerTextDocumentContentProvider("fixture-symbol", {
      provideTextDocumentContent: () => "nested",
    }),
    vscode.languages.registerDocumentSymbolProvider({ scheme: "fixture-symbol" }, {
      provideDocumentSymbols(document) {
        if (document.uri.path === "/empty") return [];
        if (document.getText() !== "nested") throw new Error("Missing virtual snapshot");
        const range = new vscode.Range(0, 0, 0, 6);
        const selection = new vscode.Range(0, 1, 0, 3);
        return [new vscode.DocumentSymbol("virtual", "symbol detail", vscode.SymbolKind.Class, range, selection)];
      },
    }),
    vscode.commands.registerCommand("audit.queryDocumentSymbols", async () => {
      const query = uri => vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
      const unopened = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "unopened.fixture");
      const virtual = vscode.Uri.parse("fixture-symbol:/draft?shape=tree#body");
      const [current, lazy, tree] = await Promise.all([query(runtimeFile.uri), query(unopened), query(virtual)]);
      const shape = (symbol, uri) => ({
        typed: symbol instanceof vscode.SymbolInformation && symbol.location instanceof vscode.Location &&
          symbol.location.range === symbol.range && symbol.selectionRange instanceof vscode.Range &&
          symbol.location.uri === uri,
        name: symbol.name,
        detail: symbol.detail,
        container: symbol.containerName,
        selectionStart: symbol.selectionRange.start.character,
        children: symbol.children.map(child => shape(child, uri)),
      });
      return {
        current: current.map(item => shape(item, runtimeFile.uri)),
        lazy: lazy.map(item => shape(item, unopened)),
        virtual: tree.map(item => shape(item, virtual)),
        empty: await query(vscode.Uri.parse("fixture-symbol:/empty")) === undefined,
      };
    }),
  );
};
`,
  );

  const original = {
    uri: Uri.file(join(root, "open.fixture")).toJSON(),
    text: "outer inner\nsecond",
    languageId: "plaintext",
    version: 4,
    eol: 1 as const,
    isDirty: true,
  };
  const unopened = {
    ...original,
    uri: Uri.file(join(root, "unopened.fixture")).toJSON(),
    version: 1,
    isDirty: false,
  };
  const host = await createExtensionHostFixture();
  const session = "audit-document-symbol-command";
  const registrations = Promise.withResolvers<void>();
  let registered = 0;
  const unlisten = host.service.onMainThreadCall(async (id, method, args, request) => {
    const result =
      method.startsWith("languages.") || method === "workspace.openTextDocument"
        ? await page.evaluate(
            async ({ id, method, args }) =>
              (await import("/tests/vscode-provider-commands.fixture.ts")).dispatchProviderCommand(
                id,
                method,
                args,
              ),
            { id, method, args },
          )
        : undefined;
    host.service.resolveMainCall(request, result);
    if (method === "languages.registerProvider" && ++registered === 2) registrations.resolve();
  });
  try {
    await page.exposeFunction("invokeSymbolProvider", (id: string, name: string, args: unknown[]) =>
      host.service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(
      async ({ original, unopened }) => {
        const { openProviderCommandModel } =
          await import("/tests/vscode-provider-commands.fixture.ts");
        const invoke = (
          window as typeof window & {
            invokeSymbolProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeSymbolProvider;
        openProviderCommandModel(original, invoke, [unopened]);
      },
      { original, unopened },
    );
    await host.service.scanExtensions(extensions);
    await host.service.startSession(session, [root], {
      documents: [original],
      storageRoot: join(root, "storage"),
    });
    await host.service.activateByEvent(session, "onStartupFinished");
    await registrations.promise;

    const shape = (name: string, container: string) => ({
      typed: true,
      name,
      detail: "",
      container,
      selectionStart: 0,
      children: [],
    });
    const expectFlatTree = (name: string) => [
      { ...shape(name, "file-scope"), children: [shape("child", name), shape("sibling", name)] },
    ];
    expect(await host.service.executeCommand(session, "audit.queryDocumentSymbols")).toEqual({
      current: expectFlatTree("current"),
      lazy: expectFlatTree("unopened"),
      virtual: [{ ...shape("virtual", ""), detail: "symbol detail", selectionStart: 1 }],
      empty: true,
    });
    const uris = [
      original.uri,
      unopened.uri,
      Uri.parse("fixture-symbol:/draft?shape=tree#body").toJSON(),
    ];
    const remaining = await page.evaluate(async (resources) => {
      const { hasResourceQueryModel } = await import("/tests/vscode-provider-commands.fixture.ts");
      return resources.some(hasResourceQueryModel);
    }, uris);
    expect(remaining).toBe(false);
  } finally {
    await host.dispose(session);
    unlisten();
    await page.evaluate(async () =>
      (await import("/tests/vscode-provider-commands.fixture.ts")).closeProviderCommandModel(),
    );
  }
});
