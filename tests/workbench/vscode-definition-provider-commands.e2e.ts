import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("definition commands preserve locations and links returned by Monaco providers", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-definitions-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "definitions");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "definitions",
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
  const source = vscode.workspace.textDocuments[0];
  const virtual = vscode.Uri.parse("fixture-definition://test/type?kind=class#declaration");
  const selector = { language: "plaintext", scheme: "file", pattern: "**/*.fixture" };
  const range = new vscode.Range(0, 1, 0, 4);
  let browserModel;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(virtual.scheme, {
      provideTextDocumentContent: () => "virtual type",
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position, token) {
        if (document !== source || document.getText() !== "dirty symbol" ||
            !position.isEqual(new vscode.Position(0, 2)) || token.isCancellationRequested)
          throw new Error("Incorrect definition provider arguments");
        const target = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "target.fixture");
        const location = new vscode.Location(target, range);
        return [
          location,
          location,
          new vscode.Location(source.uri, range),
          new vscode.Location(browserModel, range),
        ];
      },
    }),
    vscode.languages.registerTypeDefinitionProvider({ scheme: virtual.scheme }, {
      provideTypeDefinition(document) {
        if (document.uri.toString() !== virtual.toString() || document.getText() !== "virtual type")
          throw new Error("Incorrect virtual document");
        return [{ targetUri: virtual, originSelectionRange: range, targetRange: new vscode.Range(0, 0, 0, 12) }];
      },
    }),
    vscode.commands.registerCommand("audit.queryDefinitions", async (browserModelUri) => {
      browserModel = vscode.Uri.from(browserModelUri);
      const position = new vscode.Position(0, 2);
      const definition = "vscode.executeDefinitionProvider";
      const typeDefinition = "vscode.executeTypeDefinitionProvider";
      const [locations, links, empty] = await Promise.all([
        vscode.commands.executeCommand(definition, source.uri, position),
        vscode.commands.executeCommand(typeDefinition, virtual, position),
        vscode.commands.executeCommand(definition, virtual, position),
      ]);
      return {
        definitions: locations.map(location => ({
          path: location.uri.path,
          typed: location instanceof vscode.Location && location.uri instanceof vscode.Uri && location.range.isEqual(range),
        })),
        types: links.map(link => ({
          uri: link.targetUri.toString(),
          typed: link.targetUri instanceof vscode.Uri && link.originSelectionRange.isEqual(range) &&
            link.targetRange instanceof vscode.Range && link.targetSelectionRange === undefined,
        })),
        empty,
      };
    }),
  );
};
`,
  );

  const snapshot = {
    uri: Uri.file(join(root, "source.fixture")).toJSON(),
    text: "dirty symbol",
    languageId: "plaintext",
    version: 4,
    eol: 1 as const,
    isDirty: true,
  };
  const fixtureUrl = "/tests/vscode-provider-commands.fixture.ts";
  const virtual = Uri.parse("fixture-definition://test/type?kind=class#declaration");
  const host = await createExtensionHostFixture();
  const session = "definition-commands";
  const registrations = Promise.withResolvers<void>();
  let registered = 0;
  const unlisten = host.service.onMainThreadCall(async (id, method, args, request) => {
    try {
      const result = method.startsWith("languages.")
        ? await page.evaluate(
            async ({ fixtureUrl, id, method, args }) =>
              (await import(fixtureUrl)).dispatchProviderCommand(id, method, args),
            { fixtureUrl, id, method, args },
          )
        : undefined;
      host.service.resolveMainCall(request, result);
      if (method === "languages.registerProvider" && ++registered === 2) registrations.resolve();
    } catch (error) {
      host.service.resolveMainCall(request, undefined, error);
      registrations.reject(error);
    }
  });
  try {
    await page.exposeFunction(
      "invokeDefinitionProvider",
      (id: string, name: string, args: unknown[]) => host.service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    const browserModelUri = await page.evaluate(
      async ({ fixtureUrl, snapshot }) => {
        const fixture = await import(fixtureUrl);
        const browser = window as typeof window & {
          invokeDefinitionProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
        };
        return fixture.openProviderCommandModel(snapshot, browser.invokeDefinitionProvider);
      },
      { fixtureUrl, snapshot },
    );
    await host.service.scanExtensions(extensions);
    await host.service.startSession(session, [root], {
      documents: [snapshot],
      storageRoot: join(root, "storage"),
    });
    await host.service.activateByEvent(session, "onStartupFinished");
    await registrations.promise;
    expect(
      await host.service.executeCommand(session, "audit.queryDefinitions", browserModelUri),
    ).toEqual({
      definitions: [
        { path: join(root, "source.fixture"), typed: true },
        { path: join(root, "target.fixture"), typed: true },
      ],
      types: [{ uri: virtual.toString(), typed: true }],
      empty: [],
    });
    expect(
      await page.evaluate(
        async ({ fixtureUrl, resources }) => {
          const fixture = await import(fixtureUrl);
          return resources.some((uri) => fixture.hasResourceQueryModel(uri));
        },
        { fixtureUrl, resources: [snapshot.uri, virtual.toJSON()] },
      ),
    ).toBe(false);
  } finally {
    unlisten();
    await host.dispose(session);
    await page.evaluate(async (fixtureUrl) => {
      (await import(fixtureUrl)).closeProviderCommandModel();
    }, fixtureUrl);
  }
});
