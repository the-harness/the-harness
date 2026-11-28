import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Uri } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("link command resolves the requested prefix and releases native and extension link lists", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-link-command-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "links");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "links",
      publisher: "audit",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(extension, "index.cjs"),
    `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const original = new WeakMap();
  const resolutions = [];
  const virtual = vscode.Uri.parse("link-fixture://source/links?mode=live#anchor");
  subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("link-fixture", {
      provideTextDocumentContent: () => "virtual content",
    }),
    vscode.languages.registerDocumentLinkProvider([
      { scheme: "file", language: "plaintext", pattern: "**/sample.link-fixture" },
      { scheme: "link-fixture" },
    ], {
      provideDocumentLinks(document, token) {
        if (token.isCancellationRequested) throw Error("Provider canceled");
        if (document.uri.scheme === "link-fixture") {
          if (document.uri.toString() !== virtual.toString() || document.getText() !== "virtual content")
            throw Error("Expected the virtual document");
          return [new vscode.DocumentLink(new vscode.Range(0, 0, 0, 7), virtual)];
        }
        if (document !== vscode.workspace.textDocuments[0] || !document.isDirty)
          throw Error("Expected the dirty working copy");
        const first = new vscode.DocumentLink(
          new vscode.Range(0, 0, 0, 5), vscode.Uri.parse("https://example.test/eager"),
        );
        first.tooltip = "Already resolved";
        const second = new vscode.DocumentLink(new vscode.Range(0, 7, 0, 13));
        const third = new vscode.DocumentLink(new vscode.Range(1, 0, 1, 6));
        original.set(second, "second");
        original.set(third, "third");
        return [first, second, third];
      },
      resolveDocumentLink(link, token) {
        const key = original.get(link);
        if (!key || token.isCancellationRequested) throw Error("Expected the original unresolved link");
        resolutions.push(key);
        if (key === "third") throw Error("Fixture resolver failed");
        link.target = virtual;
        link.tooltip = "Resolved tooltip";
        return link;
      },
    }),
    vscode.commands.registerCommand("linkFixture.query", async (scheme, count) => {
      const uri = scheme === "file" ? vscode.workspace.textDocuments[0].uri : virtual;
      const links = await vscode.commands.executeCommand("vscode.executeLinkProvider", uri, count);
      return links?.map(link => ({
        linkTyped: link instanceof vscode.DocumentLink,
        rangeTyped: link.range instanceof vscode.Range,
        targetTyped: link.target === undefined || link.target instanceof vscode.Uri,
        range: [link.range.start.line, link.range.start.character, link.range.end.character],
        target: link.target?.toString() ?? null,
        tooltip: link.tooltip ?? null,
      })) ?? null;
    }),
    vscode.commands.registerCommand("linkFixture.resolutions", () => resolutions),
  );
};
`,
  );
  const snapshot = {
    uri: Uri.file(join(root, "sample.link-fixture")).toJSON(),
    text: "first  second\nthird    native",
    languageId: "plaintext",
    version: 2,
    eol: 1 as const,
    isDirty: true,
  };
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const session = "vscode-link-command";
  const registration = Promise.withResolvers<void>();
  let released = 0;
  const unlisten = host.onMainThreadCall(async (id, method, args, request) => {
    try {
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
      host.resolveMainCall(request, result);
      if (method === "languages.registerProvider") registration.resolve();
    } catch (error) {
      host.resolveMainCall(request, undefined, String(error));
      if (method === "languages.registerProvider") registration.reject(error);
    }
  });
  try {
    await page.exposeFunction(
      "invokeLinkProvider",
      async (id: string, name: string, args: unknown[]) => {
        const result = await host.executeCommand(id, name, ...args);
        if (name.startsWith("__lang.releaseDocumentLink.")) released++;
        return result;
      },
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(async (document) => {
      const { openProviderCommandModel } =
        await import("/tests/vscode-provider-commands.fixture.ts");
      const { registerNativeLinkFixture } = await import("/tests/vscode-link-command.fixture.ts");
      openProviderCommandModel(
        document,
        (
          window as Window & {
            invokeLinkProvider(id: string, name: string, args: unknown[]): Promise<unknown>;
          }
        ).invokeLinkProvider,
      );
      registerNativeLinkFixture();
    }, snapshot);
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], {
      documents: [snapshot],
      storageRoot: join(root, "storage"),
    });
    await host.activateByEvent(session, "onStartupFinished");
    await registration.promise;

    const query = (scheme: string, count?: number) =>
      host.executeCommand(session, "linkFixture.query", scheme, count);
    const typed = { linkTyped: true, rangeTyped: true, targetTyped: true };
    const virtual = Uri.parse("link-fixture://source/links?mode=live#anchor").toString();
    const eager = {
      ...typed,
      range: [0, 0, 5],
      target: "https://example.test/eager",
      tooltip: "Already resolved",
    };
    const lazy = { ...typed, range: [0, 7, 13], target: null, tooltip: null };
    const third = { ...typed, range: [1, 0, 6], target: null, tooltip: null };
    const native = {
      ...typed,
      range: [1, 9, 14],
      target: "https://example.test/native",
      tooltip: "Native provider",
    };
    expect(await query("file")).toEqual([eager, lazy, third, native]);
    expect(await query("file", 2)).toEqual([
      eager,
      { ...lazy, target: virtual, tooltip: "Resolved tooltip" },
      third,
      native,
    ]);
    expect(await host.executeCommand(session, "linkFixture.resolutions")).toEqual(["second"]);
    await expect(query("file", 3)).rejects.toThrow("Fixture resolver failed");
    expect(await query("virtual")).toEqual([
      { ...typed, range: [0, 0, 7], target: virtual, tooltip: null },
    ]);
    await expect.poll(() => released).toBe(4);
    expect(
      await page.evaluate(async () =>
        (await import("/tests/vscode-link-command.fixture.ts")).releasedNativeLinkLists(),
      ),
    ).toBe(3);
    expect(
      await page.evaluate(
        async (uri) =>
          (await import("/tests/vscode-provider-commands.fixture.ts")).hasResourceQueryModel(uri),
        snapshot.uri,
      ),
    ).toBe(false);
  } finally {
    unlisten();
    await fixture.dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
