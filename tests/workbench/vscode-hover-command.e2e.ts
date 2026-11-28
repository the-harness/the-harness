import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Uri, type TextDocumentSnapshot } from "../../packages/vscode-types/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("returns typed hovers from the browser registry with default ranges", async ({ page }) => {
  const artifacts = resolve("temp/artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "vscode-hover-command-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "hover");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "test",
      name: "hover",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(extension, "index.cjs"),
    String.raw`
const v = require("vscode");
exports.activate = ({ subscriptions }) => {
  const current = v.workspace.textDocuments[0];
  const rich = new v.MarkdownString("$(info) [relative](./info.md)", true);
  rich.isTrusted = { enabledCommands: ["fixture.open"] };
  rich.supportHtml = true;
  rich.baseUri = v.Uri.parse("https://example.org/docs/");
  subscriptions.push(
    v.languages.registerHoverProvider({ language: "plaintext", scheme: "file" }, {
      provideHover(document, position, token) {
        if (document !== current || document.getText() !== "draft token" || token.isCancellationRequested)
          throw new Error("Expected the live working copy");
        return new v.Hover(rich);
      },
    }),
    v.languages.registerHoverProvider({ language: "plaintext", scheme: "file" }, {
      provideHover() {
        return new v.Hover({ language: "ini", value: "key=value" }, new v.Range(0, 0, 0, 5));
      },
    }),
    v.workspace.registerTextDocumentContentProvider("fixture-hover", {
      provideTextDocumentContent: () => "body\n   ",
    }),
    v.languages.registerHoverProvider({ scheme: "fixture-hover" }, {
      provideHover(document) {
        return new v.Hover(document.uri.path === "/empty" ? [] : document.getText());
      },
    }),
    v.commands.registerCommand("fixture.query", async () => {
      const query = (uri, line, character) =>
        v.commands.executeCommand("vscode.executeHoverProvider", uri, new v.Position(line, character));
      const summarize = hovers => hovers.map(hover => ({
        typed: hover instanceof v.Hover && hover.range instanceof v.Range &&
          hover.contents.every(content => content instanceof v.MarkdownString),
        range: [hover.range.start.line, hover.range.start.character, hover.range.end.character],
        value: hover.contents[0].value,
        trusted: hover.contents[0].isTrusted,
        html: hover.contents[0].supportHtml,
        icons: hover.contents[0].supportThemeIcons,
        baseUri: hover.contents[0].baseUri?.toString(),
        typedBaseUri: hover.contents[0].baseUri instanceof v.Uri,
      }));
      return {
        file: summarize(await query(current.uri, 0, 7)),
        virtual: summarize(await query(v.Uri.parse("fixture-hover:/virtual?preview=1"), 1, 1)),
        empty: await query(v.Uri.parse("fixture-hover:/empty"), 1, 1),
      };
    }),
  );
};
`,
  );

  const original: TextDocumentSnapshot = {
    uri: Uri.file(join(root, "draft.fixture")).toJSON(),
    text: "draft token",
    version: 2,
    languageId: "plaintext",
    isDirty: true,
    eol: 1,
  };
  const { service: host, dispose } = await createExtensionHostFixture();
  const session = "hover-command";
  const ready = Promise.withResolvers<void>();
  const registrationErrors: unknown[] = [];
  let providers = 0;
  const off = host.onMainThreadCall(async (id, method, args, requestId) => {
    try {
      const result =
        method === "workspace.resolveDocumentLanguage"
          ? "plaintext"
          : method.startsWith("languages.")
            ? await page.evaluate(
                async (input) =>
                  (
                    await import("/tests/vscode-provider-commands.fixture.ts")
                  ).dispatchProviderCommand(input.id, input.method, input.args),
                { id, method, args },
              )
            : undefined;
      host.resolveMainCall(requestId, result);
    } catch (error) {
      host.resolveMainCall(requestId, undefined, error as Error);
      if (method === "languages.registerProvider") registrationErrors.push(error);
    } finally {
      if (method === "languages.registerProvider" && ++providers === 3) ready.resolve();
    }
  });
  try {
    await page.exposeFunction(
      "invokeHoverProvider",
      (id: string, command: string, args: unknown[]) => host.executeCommand(id, command, ...args),
    );
    await page.goto("/tests/vscode-empty.fixture.html");
    await page.evaluate(async (snapshot) => {
      const { openProviderCommandModel } =
        await import("/tests/vscode-provider-commands.fixture.ts");
      const invoke = (
        window as typeof window & {
          invokeHoverProvider(id: string, command: string, args: unknown[]): Promise<unknown>;
        }
      ).invokeHoverProvider;
      openProviderCommandModel(snapshot, invoke);
    }, original);
    await host.scanExtensions(extensions);
    await host.startSession(session, [root], {
      documents: [original],
      storageRoot: join(root, "storage"),
    });
    await host.activateByEvent(session, "onStartupFinished");
    await ready.promise;
    expect(registrationErrors).toEqual([]);

    expect(await host.executeCommand(session, "fixture.query")).toEqual({
      file: expect.arrayContaining([
        expect.objectContaining({
          typed: true,
          range: [0, 6, 11],
          value: "$(info) [relative](./info.md)",
          trusted: { enabledCommands: ["fixture.open"] },
          html: true,
          icons: true,
          baseUri: "https://example.org/docs/",
          typedBaseUri: true,
        }),
        expect.objectContaining({
          typed: true,
          range: [0, 0, 5],
          value: expect.stringContaining("key=value"),
        }),
      ]),
      virtual: [expect.objectContaining({ typed: true, range: [1, 1, 1], value: "body\n   " })],
      empty: [],
    });
    const retained = await page.evaluate(
      async (resources) => {
        const { hasResourceQueryModel } =
          await import("/tests/vscode-provider-commands.fixture.ts");
        return resources.some(hasResourceQueryModel);
      },
      [original.uri, Uri.parse("fixture-hover:/virtual?preview=1").toJSON()],
    );
    expect(retained).toBe(false);
  } finally {
    off();
    await page
      .evaluate(async () => {
        (await import("/tests/vscode-provider-commands.fixture.ts")).closeProviderCommandModel();
      })
      .catch(() => undefined);
    await dispose(session);
    await rm(root, { recursive: true, force: true });
  }
});
