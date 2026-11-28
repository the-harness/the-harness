import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Position, Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extension = String.raw`
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("selection-fixture", {
    provideTextDocumentContent: () => "alpha beta gamma!\nsecond line",
  }));
  subscriptions.push(vscode.languages.registerSelectionRangeProvider(
    { scheme: "selection-fixture", pattern: "**/range.txt", language: "plaintext" },
    {
      provideSelectionRanges(document, positions) {
        if (document.uri.query !== "v=2" || document.getText() !== "alpha beta gamma!\nsecond line" ||
            positions.some(position => !(position instanceof vscode.Position))) {
          throw new Error("Wrong virtual document or positions");
        }
        return positions.map(({ character }) => character === 13
          ? new vscode.SelectionRange(new vscode.Range(0, 11, 0, 16),
              new vscode.SelectionRange(new vscode.Range(0, 6, 0, 17)))
          : new vscode.SelectionRange(new vscode.Range(0, 0, 0, 5),
              new vscode.SelectionRange(new vscode.Range(0, 0, 0, 10))));
      },
    },
  ));
  subscriptions.push(vscode.commands.registerCommand("fixture.selectionRanges", async (file) => {
    const uri = file ? vscode.Uri.file(file) : vscode.Uri.parse("selection-fixture:/range.txt?v=2#body");
    const positions = file ? [new vscode.Position(0, 7)]
      : [new vscode.Position(0, 13), new vscode.Position(0, 2)];
    const result = await vscode.commands.executeCommand("vscode.executeSelectionRangeProvider", uri, positions);
    return result.map(selection => {
      const ranges = [];
      for (let node = selection; node; node = node.parent) {
        if (!(node instanceof vscode.SelectionRange) || !(node.range instanceof vscode.Range) ||
            (node.parent && !node.parent.range.contains(node.range))) throw new Error("Invalid range chain");
        const { start, end } = node.range;
        ranges.push([start.line, start.character, end.line, end.character]);
      }
      return ranges;
    });
  }));
};
`;

test("executes Smart Select for an extension document and a dirty file", async ({ page }) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-selection-range-command-"));
  const installed = join(root, "extensions");
  const fixture = join(installed, "selection");
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "selection",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(join(fixture, "index.cjs"), extension);

  const file = join(root, "dirty.txt");
  const snapshot = {
    uri: Uri.file(join(root, "unrelated.txt")).toJSON(),
    text: "",
    languageId: "plaintext",
    version: 1,
    isDirty: false,
    eol: 1 as const,
  };
  const virtual = Uri.parse("selection-fixture:/range.txt?v=2#body");
  const { service, dispose } = await createExtensionHostFixture();
  const session = "selection-range-command";
  const module = "/tests/vscode-provider-commands.fixture.ts";
  const registered = Promise.withResolvers<void>();
  const unlisten = service.onMainThreadCall(async (id, method, args, request) => {
    try {
      let result: unknown;
      if (method.startsWith("languages.") || method === "workspace.openTextDocument") {
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
      if (method === "languages.registerProvider") registered.resolve();
    } catch (error) {
      service.resolveMainCall(request, undefined, String(error));
      if (method === "languages.registerProvider") registered.reject(error);
    }
  });

  try {
    await page.exposeFunction(
      "invokeSelectionProvider",
      (id: string, name: string, args: unknown[]) => service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(
      async ({ module, snapshot, fileUri }) => {
        const { openProviderCommandModel } = await import(module);
        const invoke = (
          window as unknown as {
            invokeSelectionProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeSelectionProvider;
        openProviderCommandModel(snapshot, invoke, [
          { ...snapshot, uri: fileUri, text: "paintBrush(upper)\nsecond line", isDirty: true },
        ]);
      },
      { module, snapshot, fileUri: Uri.file(file).toJSON() },
    );
    await service.scanExtensions(installed);
    await service.startSession(session, [root], { storageRoot: join(root, "storage") });
    await service.activateByEvent(session, "onStartupFinished");
    await registered.promise;

    const query = (...args: string[]) =>
      service.executeCommand(session, "fixture.selectionRanges", ...args);
    expect(await query()).toEqual([
      [
        [0, 11, 0, 16],
        [0, 6, 0, 17],
        [0, 0, 0, 17],
        [0, 0, 1, 11],
      ],
      [
        [0, 0, 0, 5],
        [0, 0, 0, 10],
        [0, 0, 0, 17],
        [0, 0, 1, 11],
      ],
    ]);
    expect(await query(file)).toEqual([
      [
        [0, 5, 0, 10],
        [0, 0, 0, 10],
        [0, 0, 0, 17],
        [0, 0, 1, 11],
      ],
    ]);
    expect(
      await service.executeCommand(session, "vscode.executeSelectionRangeProvider", virtual, []),
    ).toEqual([]);
    await expect(
      service.executeCommand(
        session,
        "vscode.executeSelectionRangeProvider",
        virtual,
        new Position(0, 2),
      ),
    ).rejects.toThrow("Expected a document URI and an array of positions");
    expect(
      await page.evaluate(
        async ({ module, uris }) => {
          const { hasResourceQueryModel } = await import(module);
          return uris.some(hasResourceQueryModel);
        },
        { module, uris: [Uri.file(file).toJSON(), virtual.toJSON()] },
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
