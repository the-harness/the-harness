import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

const extension = String.raw`
const vscode = require("vscode");
const { Position, Range, TextEdit, EndOfLine } = vscode;
exports.activate = ({ subscriptions }) => {
  const virtual = vscode.Uri.parse("format-fixture:/target.txt?v=2#body");
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(virtual.scheme, {
    provideTextDocumentContent: () => "bad end\nsecond",
  }));
  subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: virtual.scheme, pattern: "**/target.txt" },
    {
      provideDocumentFormattingEdits(document, options) {
        if (document.uri.toString() !== virtual.toString() || document.getText() !== "bad end\nsecond" ||
            options.tabSize !== 2 || options.insertSpaces !== false || options.preserveDetails !== "yes")
          throw new Error("Unexpected document formatting arguments");
        return [TextEdit.replace(new Range(0, 0, 0, 3), "OK!"), TextEdit.setEndOfLine(EndOfLine.CRLF)];
      },
    },
  ));
  subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(
    { scheme: virtual.scheme, pattern: "**/target.txt" },
    {
      provideDocumentRangeFormattingEdits(document, range, options) {
        if (document.uri.toString() !== virtual.toString() || !(range instanceof Range) ||
            range.start.character !== 4 || range.end.character !== 7 || options.insertSpaces !== true)
          throw new Error("Unexpected range formatting arguments");
        return [TextEdit.replace(range, "X" + options.tabSize)];
      },
    },
  ));
  subscriptions.push(vscode.languages.registerOnTypeFormattingEditProvider(
    { scheme: "file", pattern: "**/dirty.txt" },
    {
      provideOnTypeFormattingEdits(document, position, ch, options) {
        if (document.getText() !== "bad;" || !document.isDirty || !(position instanceof Position) ||
            position.character !== 4 || ch !== ";" || options.tabSize !== 8 || !options.insertSpaces)
          throw new Error("Unexpected on-type formatting arguments");
        return [TextEdit.replace(new Range(0, 0, 0, 3), "FMT")];
      },
    },
    ";",
  ));
  subscriptions.push(vscode.commands.registerCommand("fixture.formatting", async (file) => {
    const run = vscode.commands.executeCommand;
    const dirty = vscode.Uri.file(file);
    const shape = (edits) => edits?.map(edit => {
      if (!(edit instanceof TextEdit) || !(edit.range instanceof Range)) throw new Error("Expected typed edits");
      const { start, end } = edit.range;
      return [start.line, start.character, end.line, end.character, edit.newText, edit.newEol ?? null];
    }) ?? null;
    const document = shape(await run("vscode.executeFormatDocumentProvider", virtual,
      { tabSize: 2, insertSpaces: false, preserveDetails: "yes" }));
    const range = shape(await run("vscode.executeFormatRangeProvider", virtual, new Range(0, 4, 0, 7),
      { tabSize: 99 }));
    const onType = shape(await run("vscode.executeFormatOnTypeProvider", dirty, new Position(0, 4),
      ";", { tabSize: 8, insertSpaces: true }));
    const unmatched = shape(await run("vscode.executeFormatOnTypeProvider", dirty, new Position(0, 4), "."));
    const contents = await Promise.all([virtual, dirty].map(async uri =>
      (await vscode.workspace.openTextDocument(uri)).getText()));
    return { document, range, onType, unmatched, contents };
  }));
};
`;

test("queries all three formatting providers through Monaco and revives their edits", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-formatting-commands-"));
  const installed = join(root, "extensions");
  const fixture = join(installed, "format");
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "format",
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
  const { service, dispose } = await createExtensionHostFixture();
  const session = "formatting-commands";
  const module = "/tests/vscode-provider-commands.fixture.ts";
  const registered = Promise.withResolvers<void>();
  let registrations = 0;
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
      if (method === "languages.registerProvider" && ++registrations === 3) registered.resolve();
    } catch (error) {
      service.resolveMainCall(request, undefined, String(error));
      if (method === "languages.registerProvider") registered.reject(error);
    }
  });
  try {
    await page.exposeFunction("invokeFormatting", (id: string, name: string, args: unknown[]) =>
      service.executeCommand(id, name, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(
      async ({ module, fileUri, snapshot }) => {
        const { openProviderCommandModel } = await import(module);
        const invoke = (
          window as unknown as {
            invokeFormatting(id: string, name: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeFormatting;
        openProviderCommandModel(snapshot, invoke, [
          { ...snapshot, uri: fileUri, text: "bad;", isDirty: true },
        ]);
      },
      { module, fileUri: Uri.file(file).toJSON(), snapshot },
    );
    await service.scanExtensions(installed);
    await service.startSession(session, [root], { storageRoot: join(root, "storage") });
    await service.activateByEvent(session, "onStartupFinished");
    await registered.promise;

    expect(await service.executeCommand(session, "fixture.formatting", file)).toEqual({
      document: [
        [0, 0, 0, 3, "OK!", null],
        [0, 0, 0, 0, "", 2],
      ],
      range: [[0, 4, 0, 7, "X4", null]],
      onType: [[0, 0, 0, 3, "FMT", null]],
      unmatched: null,
      contents: ["bad end\nsecond", "bad;"],
    });
    const virtualUri = Uri.parse("format-fixture:/target.txt?v=2#body").toJSON();
    expect(
      await page.evaluate(
        async ({ module, resources }) => {
          const { hasResourceQueryModel } = await import(module);
          return resources.some(hasResourceQueryModel);
        },
        { module, resources: [Uri.file(file).toJSON(), virtualUri] },
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
