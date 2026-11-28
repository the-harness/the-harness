import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("returns typed results from extension color providers through the Monaco command registry", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-color-commands-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "colors");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "colors",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  writeFileSync(
    join(extension, "index.cjs"),
    `
const vscode = require("vscode");

exports.activate = context => {
  const range = new vscode.Range(0, 1, 0, 6);
  context.subscriptions.push(vscode.languages.registerColorProvider({
    language: "plaintext", scheme: "file", pattern: "**/shade.sample",
  }, {
    provideDocumentColors(document, token) {
      if (document !== vscode.workspace.textDocuments[0] || token.isCancellationRequested)
        throw Error("Expected an active request for the existing document");
      return [new vscode.ColorInformation(range, new vscode.Color(0.5, 0.25, 0.125, 0.75))];
    },
    provideColorPresentations(color, context) {
      if (!(color instanceof vscode.Color) || !context.range.isEqual(range) || color.alpha !== 0.75)
        throw Error("Expected a VS Code Color and the original range");
      const presentation = new vscode.ColorPresentation("Shade");
      presentation.textEdit = vscode.TextEdit.replace(context.range, "mixed");
      const extra = vscode.TextEdit.insert(new vscode.Position(1, 0), "extra ");
      extra.newEol = vscode.EndOfLine.CRLF;
      presentation.additionalTextEdits = [extra];
      return [presentation, new vscode.ColorPresentation("plain")];
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand("audit.queryColors", async () => {
    const uri = vscode.workspace.textDocuments[0].uri;
    const query = () => vscode.commands.executeCommand("vscode.executeDocumentColorProvider", uri);
    const [colors, repeated] = await Promise.all([query(), query()]);
    const [info] = colors;
    const presentations = await vscode.commands.executeCommand(
      "vscode.executeColorPresentationProvider", info.color, { uri, range: info.range },
    );
    const [presentation] = presentations;
    return {
      colors,
      presentations,
      typed: colors.length === 1 && repeated.length === 1 && info instanceof vscode.ColorInformation &&
        info.range.isEqual(range) && info.color instanceof vscode.Color &&
        presentations.every(item => item instanceof vscode.ColorPresentation) &&
        presentation.textEdit instanceof vscode.TextEdit &&
        presentation.additionalTextEdits[0] instanceof vscode.TextEdit &&
        presentation.textEdit.range.isEqual(range),
    };
  }));
};
`,
  );

  const snapshot = {
    uri: Uri.file(join(root, "shade.sample")).toJSON(),
    text: " shade\nvalue",
    languageId: "plaintext",
    version: 1,
    eol: 1 as const,
    isDirty: false,
  };
  const host = await createExtensionHostFixture();
  const session = "audit-color-commands";
  const registration = Promise.withResolvers<void>();
  const unlisten = host.service.onMainThreadCall(async (id, method, args, request) => {
    const result = method.startsWith("languages.")
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
    if (method === "languages.registerProvider") registration.resolve();
  });
  try {
    await page.exposeFunction("invokeColorProvider", (id: string, name: string, args: unknown[]) =>
      host.service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(async (data) => {
      const { openProviderCommandModel } =
        await import("/tests/vscode-provider-commands.fixture.ts");
      const invoke = (
        window as typeof window & {
          invokeColorProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
        }
      ).invokeColorProvider;
      openProviderCommandModel(data, invoke);
    }, snapshot);
    await host.service.scanExtensions(extensions);
    await host.service.startSession(session, [root], {
      documents: [snapshot],
      storageRoot: join(root, "storage"),
    });
    await host.service.activateByEvent(session, "onStartupFinished");
    await registration.promise;
    expect(await host.service.executeCommand(session, "audit.queryColors")).toMatchObject({
      typed: true,
      colors: [{ color: { red: 0.5, green: 0.25, blue: 0.125, alpha: 0.75 } }],
      presentations: [
        {
          label: "Shade",
          textEdit: { newText: "mixed", range: { start: { line: 0, character: 1 } } },
          additionalTextEdits: [{ newText: "extra ", newEol: 2 }],
        },
        { label: "plain" },
      ],
    });
    expect(
      await page.evaluate(
        async (uri) =>
          (await import("/tests/vscode-provider-commands.fixture.ts")).hasResourceQueryModel(uri),
        snapshot.uri,
      ),
    ).toBe(false);
  } finally {
    await host.dispose(session);
    unlisten();
    await page.evaluate(async () =>
      (await import("/tests/vscode-provider-commands.fixture.ts")).closeProviderCommandModel(),
    );
  }
});
