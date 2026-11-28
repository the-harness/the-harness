import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extension = String.raw`
const vscode = require("vscode");
const { Range, SemanticTokens, SemanticTokensLegend, Uri } = vscode;
exports.activate = ({ subscriptions }) => {
  const scheme = "tokens-fixture";
  const full = { scheme, language: "plaintext", pattern: "**/full.txt" };
  const rangeOnly = { scheme, language: "plaintext", pattern: "**/range-only.txt" };
  const make = (...words) => new SemanticTokens(Uint32Array.from(words), "provider-only-id");
  const text = "abc def ghi\nsecond line";
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: () => text,
  }));
  subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(full, {
    provideDocumentSemanticTokens(document) {
      if (document.uri.query !== "v=2" || document.getText() !== text)
        throw new Error("Expected the current virtual document");
      return make(0, 0, 3, 0, 0x80000000);
    },
    provideDocumentSemanticTokensEdits() { throw new Error("Expected a fresh result"); },
  }, new SemanticTokensLegend(["variable"], Array.from({ length: 32 }, (_, i) => "modifier" + i))));
  subscriptions.push(vscode.languages.registerDocumentRangeSemanticTokensProvider(full, {
    provideDocumentRangeSemanticTokens(document, range) {
      if (document.uri.query !== "v=2" || !(range instanceof Range) ||
          range.start.character !== 4 || range.end.character !== 7)
        throw new Error("Expected the requested virtual document range");
      return make(0, 4, 3, 0, 1);
    },
  }, new SemanticTokensLegend(["method"], ["static"])));
  subscriptions.push(vscode.languages.registerDocumentRangeSemanticTokensProvider(full, {
    provideDocumentRangeSemanticTokens: () => undefined,
  }, new SemanticTokensLegend(["higherPriority"])));
  subscriptions.push(vscode.languages.registerDocumentRangeSemanticTokensProvider(rangeOnly, {
    provideDocumentRangeSemanticTokens(_document, range) {
      if (!range.isEqual(new Range(0, 0, 1, 11)))
        throw new Error("Expected a full-document fallback range");
      return make(1, 0, 6, 0, 0);
    },
  }, new SemanticTokensLegend(["string"])));

  subscriptions.push(vscode.commands.registerCommand("fixture.tokens", async () => {
    const uri = name => Uri.parse(scheme + ":/documents/" + name + ".txt?v=2#target");
    const run = (command, ...args) => vscode.commands.executeCommand("vscode.provide" + command, ...args);
    const tokenData = value => {
      if (value === undefined) return null;
      if (!(value instanceof SemanticTokens) || !(value.data instanceof Uint32Array) ||
          value.resultId !== undefined) throw new Error("Expected fresh typed semantic tokens");
      return [...value.data];
    };
    const legendData = value => {
      if (value === undefined) return null;
      if (!(value instanceof SemanticTokensLegend)) throw new Error("Expected a typed legend");
      return [value.tokenTypes, value.tokenModifiers];
    };
    const fullUri = uri("full");
    const rangeOnlyUri = uri("range-only");
    const range = new Range(0, 4, 0, 7);
    return {
      full: tokenData(await run("DocumentSemanticTokens", fullUri)),
      fullLegend: legendData(await run("DocumentSemanticTokensLegend", fullUri)),
      range: tokenData(await run("DocumentRangeSemanticTokens", fullUri, range)),
      rangeLegend: legendData(await run("DocumentRangeSemanticTokensLegend", fullUri, range)),
      legacyRangeLegend: legendData(await run("DocumentRangeSemanticTokensLegend", fullUri, null)),
      fallback: tokenData(await run("DocumentSemanticTokens", rangeOnlyUri)),
      fallbackLegend: legendData(await run("DocumentSemanticTokensLegend", rangeOnlyUri)),
      absent: tokenData(await run("DocumentSemanticTokens", uri("absent"))),
      absentLegend: legendData(await run("DocumentRangeSemanticTokensLegend", uri("absent"))),
    };
  }));
};
`;

test("queries semantic tokens and legends using Monaco's document and range provider rules", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-semantic-token-commands-"));
  const installed = join(root, "extensions");
  const directory = join(installed, "tokens");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "tokens",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(join(directory, "index.cjs"), extension);
  const snapshot = {
    uri: Uri.file(join(root, "unrelated.txt")).toJSON(),
    text: "",
    languageId: "plaintext",
    eol: 1 as const,
    version: 1,
    isDirty: false,
  };

  const { service, dispose } = await createExtensionHostFixture();
  const session = "semantic-token-commands";
  const module = "/tests/vscode-provider-commands.fixture.ts";
  const registered = Promise.withResolvers<void>();
  let registrations = 0;
  const unlisten = service.onMainThreadCall(async (id, method, args, request) => {
    try {
      let result: unknown;
      if (method.startsWith("languages.")) {
        result = await page.evaluate(
          ({ module, id, method, args }) =>
            import(module).then((fixture) => fixture.dispatchProviderCommand(id, method, args)),
          { module, id, method, args },
        );
      } else if (method === "workspace.resolveDocumentLanguage") {
        result = "plaintext";
      } else if (method === "commands.execute") {
        throw new Error(`Command '${args[0]}' not found`);
      }
      service.resolveMainCall(request, result);
      if (method === "languages.registerProvider" && ++registrations === 4) registered.resolve();
    } catch (error) {
      service.resolveMainCall(request, undefined, String(error));
      if (method === "languages.registerProvider") registered.reject(error);
    }
  });
  try {
    await page.exposeFunction("invokeTokenProvider", (id: string, name: string, args: unknown[]) =>
      service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(
      async ({ module, snapshot }) => {
        const { openProviderCommandModel } = await import(module);
        const invoke = (
          window as unknown as {
            invokeTokenProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeTokenProvider;
        openProviderCommandModel(snapshot, invoke);
      },
      { module, snapshot },
    );
    await service.scanExtensions(installed);
    await service.startSession(session, [root], { storageRoot: join(root, "storage") });
    await service.activateByEvent(session, "onStartupFinished");
    await registered.promise;

    expect(await service.executeCommand(session, "fixture.tokens")).toEqual({
      full: [0, 0, 3, 0, 0x80000000],
      fullLegend: [["variable"], Array.from({ length: 32 }, (_, i) => `modifier${i}`)],
      range: [0, 4, 3, 0, 1],
      rangeLegend: [["method"], ["static"]],
      legacyRangeLegend: [["higherPriority"], []],
      fallback: [1, 0, 6, 0, 0],
      fallbackLegend: [["string"], []],
      absent: null,
      absentLegend: null,
    });
    const resources = ["full", "range-only", "absent"].map((name) =>
      Uri.parse(`tokens-fixture:/documents/${name}.txt?v=2#target`).toJSON(),
    );
    expect(
      await page.evaluate(
        async ({ module, resources }) => {
          const { hasResourceQueryModel } = await import(module);
          return resources.some(hasResourceQueryModel);
        },
        { module, resources },
      ),
    ).toBe(false);
  } finally {
    await dispose(session);
    unlisten();
    await page.evaluate(
      async (module) => (await import(module)).closeProviderCommandModel(),
      module,
    );
    await rm(root, { recursive: true, force: true });
  }
});
