import { captureBrowserErrors } from "../helpers/browser-errors.ts";
import { createWebviewBridge } from "../helpers/webview-bridge.ts";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { serveWebviewResource } from "../../packages/vscode-ext-host/src/webview-resources.ts";

const builtins =
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

test("official CPU profile table parses and renders actual profile samples in a real custom editor", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(builtins, "ms-vscode.vscode-js-profile-table/package.json")),
    "Official profile extension is not installed",
  );
  test.setTimeout(90_000);
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/builtin-profile-browser-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  cpSync(
    join(builtins, "ms-vscode.vscode-js-profile-table"),
    join(extensions, "ms-vscode.vscode-js-profile-table"),
    { recursive: true },
  );
  const probe = join(extensions, "probe");
  mkdirSync(probe);
  writeFileSync(
    join(probe, "package.json"),
    JSON.stringify({
      publisher: "harness",
      name: "profile-probe",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:profile.activate"],
    }),
  );
  writeFileSync(
    join(probe, "extension.cjs"),
    `const v=require('vscode');exports.activate=context=>context.subscriptions.push(v.commands.registerCommand('profile.activate',()=>v.extensions.getExtension('ms-vscode.vscode-js-profile-table').activate()));`,
  );
  const profile = join(root, "fixture.cpuprofile");
  writeFileSync(
    profile,
    JSON.stringify({
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "(root)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
          hitCount: 0,
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: "computeFixture",
            scriptId: "1",
            url: join(root, "compute.cjs"),
            lineNumber: 1,
            columnNumber: 0,
          },
          hitCount: 3,
          children: [],
        },
      ],
      startTime: 0,
      endTime: 3000,
      samples: [2, 2, 2],
      timeDeltas: [1000, 1000, 1000],
    }),
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  page.on("console", (message) => {
    if (message.type() === "error")
      appendFileSync(join(root, "browser-errors.log"), message.text() + "\n");
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      appendFileSync(
        join(root, "resource-errors.log"),
        response.status() + " " + response.url() + "\n",
      );
  });
  const webviewBridge = createWebviewBridge(page, root);
  const runtime = await createBuiltinLanguageHost(root, webviewBridge.dispatch);
  const server = createServer((request, response) => {
    void serveWebviewResource(runtime.host, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/profile/`;
  await page.exposeFunction("dispatchWebviewMessage", (id: string, message: unknown) =>
    runtime.host.executeCommand("profile", `__webview.message.${id}`, message),
  );
  await page.goto("/");
  await webviewBridge.prepare();
  try {
    await runtime.host.scanExtensions(extensions);
    await runtime.host.startSession("profile", [root], {
      storageRoot: join(root, "storage"),
      webviewResourceBase: base,
      configuration: { defaults: {}, user: { "telemetry.telemetryLevel": "off" }, workspace: {} },
    });
    await runtime.host.executeCommand("profile", "profile.activate");
    await runtime.host.executeCommand(
      "profile",
      "__customEditor.resolve.jsProfileVisualizer.cpuprofile.table",
      profile,
    );
    const frame = page.frameLocator("[data-webview] iframe").first();
    await expect(frame.getByText("computeFixture", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("treeitem").filter({ hasText: "computeFixture" })).toContainText(
      "2.00ms",
    );
    const panels = await page.evaluate(async () =>
      (await import("/tests/vscode-webview.fixture.ts")).panels(),
    );
    writeFileSync(join(root, "panels.json"), JSON.stringify(panels, null, 2));
    expect(panels[0]?.html).toContain("computeFixture");
    await page.screenshot({ path: join(root, "profile.png") });
    await runtime.host.executeCommand("profile", `__webview.dispose.${panels[0]!.id}`);
    await expect(page.locator("[data-webview] iframe")).toHaveCount(0);
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
    writeFileSync(join(root, "page-errors.json"), JSON.stringify(await getBrowserErrors()));
    throw error;
  } finally {
    await runtime.dispose("profile");
    await webviewBridge.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await page.evaluate(async () =>
      (await import("/tests/vscode-webview.fixture.ts")).disposeWebviews(),
    );
  }
  expect(runtime.errors).toEqual([]);
  expect(await getBrowserErrors()).toEqual([]);
});
