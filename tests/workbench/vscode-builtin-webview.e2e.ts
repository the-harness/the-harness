import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import { createWebviewBridge } from "../helpers/webview-bridge.ts";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { serveWebviewResource } from "../../packages/vscode-ext-host/src/webview-resources.ts";
import { Uri, TextDocumentData, Range, Selection } from "../../packages/vscode-types/src/index.ts";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";

const extensionsDirectory =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

test("official Mermaid tool renders SVG in a real isolated webview and restores its preview", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "mermaid-markdown-features/package.json")),
    "Official Mermaid bundle is not installed",
  );
  test.setTimeout(90_000);
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-mermaid-browser-"));
  page.on("console", (message) => {
    if (message.type() === "error")
      appendFileSync(join(root, "browser-errors.log"), message.text() + "\n");
  });
  page.on("requestfailed", (request) =>
    appendFileSync(
      join(root, "failed-requests.log"),
      `${request.url()} ${request.failure()?.errorText}\n`,
    ),
  );
  const installed = join(root, "extensions");
  mkdirSync(installed);
  for (const name of ["mermaid-markdown-features", "markdown-language-features", "markdown-math"])
    cpSync(join(extensionsDirectory, name), join(installed, name), { recursive: true });
  const getBrowserErrors = await captureBrowserErrors(page);
  const webviewBridge = createWebviewBridge(page, root);
  const fixture = await createBuiltinLanguageHost(root, webviewBridge.dispatch);
  const resourceServer = createServer((request, response) => {
    void serveWebviewResource(fixture.host, request, response);
  });
  await new Promise<void>((resolve) => resourceServer.listen(0, "127.0.0.1", resolve));
  const address = resourceServer.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/mermaid/`;
  await page.exposeFunction("dispatchWebviewMessage", (id: string, message: unknown) =>
    fixture.host.executeCommand("mermaid", `__webview.message.${id}`, message),
  );
  await page.goto("/");
  await webviewBridge.prepare();
  try {
    await fixture.host.scanExtensions(installed);
    const source = "graph TD\n  A[Start] --> B[Done]";
    const markdownFile = join(root, "diagram.md");
    const markdownSource = "# Live preview\n\n$x^2$\n\n```mermaid\n" + source + "\n```\n";
    writeFileSync(markdownFile, markdownSource);
    const document = new TextDocumentData({
      uri: Uri.file(markdownFile).toJSON(),
      text: markdownSource,
      languageId: "markdown",
      version: 1,
      isDirty: false,
      eol: 1,
    });
    const editor = {
      document: document.toJSON(),
      selections: [new Selection(0, 0, 0, 0)],
      visibleRanges: [new Range(0, 0, 9, 0)],
      viewColumn: 1,
      options: { tabSize: 2, insertSpaces: true },
    };
    await fixture.host.startSession("mermaid", [root], {
      storageRoot: join(root, "host-storage"),
      webviewResourceBase: base,
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
      documents: [document.toJSON()],
      editors: { active: editor, visible: [editor] },
    });
    const result = await fixture.host.executeCommand<{
      content: { value: string }[];
      toolResultDetails2: { mime: string; value: number[] };
    }>("mermaid", "__lm.invokeTool", "renderMermaidDiagram", {
      input: { markup: source, title: "Builtin Mermaid" },
    });
    expect(result.content[0]?.value).toContain(source);
    expect(result.toolResultDetails2.mime).toBe("text/vnd.mermaid");
    const html = await fixture.host.executeCommand<string>(
      "mermaid",
      "__chat.renderOutput",
      "vscode.mermaid-markdown-features.chatOutputItem",
      result.toolResultDetails2,
      {},
    );
    writeFileSync(join(root, "renderer.html"), html);
    const frame = page.frameLocator("[data-webview] iframe").first();
    await expect(frame.locator(".mermaid svg")).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator(".mermaid svg")).toContainText("Start");
    await expect(frame.locator(".mermaid svg")).toContainText("Done");
    await frame.locator(".open-in-editor-btn").click();
    await expect(page.locator("[data-webview] iframe")).toHaveCount(2);
    await expect(
      page.frameLocator("[data-webview] iframe").nth(1).locator(".mermaid svg"),
    ).toBeVisible();
    await fixture.host.executeCommand("mermaid", "markdown.showPreview");
    await expect(page.locator("[data-webview] iframe")).toHaveCount(3);
    const markdown = page.frameLocator("[data-webview] iframe").nth(2);
    await expect(markdown.locator("h1")).toHaveText("Live preview");
    await expect(markdown.locator(".mermaid svg")).toBeVisible({ timeout: 30_000 });
    await expect(markdown.locator(".mermaid svg")).toContainText("Start");
    await expect(markdown.locator(".katex")).toBeVisible();
    const beforeRestore = await page.evaluate(async () =>
      (await import("/tests/vscode-webview.fixture.ts")).panels(),
    );
    const preview = beforeRestore[1]!;
    await fixture.host.executeCommand("mermaid", `__webview.dispose.${preview.id}`);
    await fixture.host.executeCommand(
      "mermaid",
      "__webview.restore.vscode.mermaid-markdown-features.preview",
      { title: "Restored Mermaid", state: { mermaidSource: source } },
    );
    await webviewBridge.drain();
    const restored = (
      await page.evaluate(async () => (await import("/tests/vscode-webview.fixture.ts")).panels())
    ).find((panel) => !beforeRestore.some((before) => before.id === panel.id))!;
    await expect(
      page.frameLocator(`[data-webview="${restored.id}"] iframe`).locator(".mermaid svg"),
    ).toBeVisible();
    const resourceUrl = /src="(http[^\"]+index\.js)"/.exec(html)?.[1];
    expect(resourceUrl).toBeTruthy();
    const valid = await fetch(resourceUrl!);
    expect(valid.status).toBe(200);
    const outside = base + beforeRestore[0]!.id + "/file" + root + "/private.txt";
    writeFileSync(join(root, "private.txt"), "not a localResourceRoot");
    expect((await fetch(outside)).status).toBe(404);
    await page.screenshot({ path: join(root, "mermaid.png") });
  } catch (error) {
    writeFileSync(
      join(root, "frames.json"),
      JSON.stringify(
        await Promise.all(
          page.frames().map(async (frame) => ({
            url: frame.url(),
            html: await frame.content().catch(() => "unavailable"),
          })),
        ),
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await fixture.dispose("mermaid");
    await webviewBridge.drain();
    await new Promise<void>((resolve) => resourceServer.close(() => resolve()));
    await page.evaluate(async () =>
      (await import("/tests/vscode-webview.fixture.ts")).disposeWebviews(),
    );
    console.info(`Mermaid webview artifacts: ${root}`);
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});

test("official Simple Browser loads a local page and a contributed URI opener updates it", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(extensionsDirectory, "simple-browser/package.json")),
    "Official Simple Browser bundle is not installed",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-simple-browser-"));
  page.on("console", (message) => {
    if (message.type() === "error")
      appendFileSync(join(root, "browser-errors.log"), message.text() + "\n");
  });
  page.on("requestfailed", (request) =>
    appendFileSync(
      join(root, "failed-requests.log"),
      `${request.url()} ${request.failure()?.errorText}\n`,
    ),
  );
  const installed = join(root, "extensions");
  mkdirSync(installed);
  cpSync(join(extensionsDirectory, "simple-browser"), join(installed, "simple-browser"), {
    recursive: true,
  });
  const getBrowserErrors = await captureBrowserErrors(page);
  const webviewBridge = createWebviewBridge(page, root);
  const fixture = await createBuiltinLanguageHost(root, webviewBridge.dispatch);
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/document")) {
      response.setHeader("content-type", "text/html");
      response.end(`<h1>Local Builtin Browser ${request.url}</h1>`);
    } else void serveWebviewResource(fixture.host, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.exposeFunction("dispatchWebviewMessage", (id: string, message: unknown) =>
    fixture.host.executeCommand("browser", `__webview.message.${id}`, message),
  );
  await page.goto("/");
  await webviewBridge.prepare();
  try {
    await fixture.host.scanExtensions(installed);
    await fixture.host.startSession("browser", [root], {
      storageRoot: join(root, "host-storage"),
      webviewResourceBase: `${origin}/browser/`,
      configuration: { defaults: {}, user: {}, workspace: {} },
    });
    await fixture.host.executeCommand("browser", "simpleBrowser.show", `${origin}/document/first`);
    const browser = page.frameLocator("[data-webview] iframe").first();
    await expect(browser.frameLocator("iframe").locator("h1")).toContainText("/document/first");
    expect(
      await fixture.host.executeCommand(
        "browser",
        "__externalUri.open",
        Uri.parse(`${origin}/document/second`).toJSON(),
        "simpleBrowser.open",
      ),
    ).toBe(true);
    await expect(browser.frameLocator("iframe").locator("h1")).toContainText("/document/second");
    await expect(page.locator("[data-webview] iframe")).toHaveCount(1);
    await page.screenshot({ path: join(root, "simple-browser.png") });
  } finally {
    await fixture.dispose("browser");
    await webviewBridge.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await page.evaluate(async () =>
      (await import("/tests/vscode-webview.fixture.ts")).disposeWebviews(),
    );
    console.info(`Simple Browser artifacts: ${root}`);
  }
  expect(fixture.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
