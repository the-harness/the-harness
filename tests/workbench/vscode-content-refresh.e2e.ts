import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("running web app refreshes official content after RPC scans without restarting its workspace", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const builtins =
    process.env.HARNESS_VSCODE_BUILTINS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(
    !existsSync(join(builtins, "groovy/package.json")),
    "Requires installed VS Code contribution resources",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "content-refresh-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const name of ["groovy", "theme-monokai", "theme-seti"])
    cpSync(join(builtins, name), join(extensions, name), { recursive: true });
  const monokaiManifestPath = join(extensions, "theme-monokai/package.json");
  const monokai = JSON.parse(readFileSync(monokaiManifestPath, "utf8"));
  monokai.contributes.configurationDefaults = { "fixture.contentRemoval": true };
  writeFileSync(monokaiManifestPath, JSON.stringify(monokai));
  const monokaiId = `${monokai.publisher}.${monokai.name}`;
  const name = `refresh.${basename(root)}`;
  const manifestPath = join(extensions, "groovy/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.contributes.languages[0].extensions.push(`.${basename(root)}`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(root, name), 'def greeting = "Hello"\nprintln greeting\n');
  const errors = await captureBrowserErrors(page);
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  await page.evaluate(
    async ({ root, name }) =>
      (await import("/tests/vscode-content-refresh.fixture.ts")).openDocument(root, name),
    { root, name },
  );
  const snapshot = () =>
    page.evaluate(async () =>
      (await import("/tests/vscode-content-refresh.fixture.ts")).snapshot(),
    );
  await expect.poll(async () => (await snapshot()).session).toBeTruthy();
  await expect.poll(async () => (await snapshot()).language).toBe("plaintext");
  const before = await snapshot();
  const scanned = await page.evaluate(
    async (directory) => (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
    extensions,
  );
  expect(scanned.map((extension: { id: string }) => extension.id)).toContain("vscode.groovy");
  await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({
    session: before.session,
    language: "groovy",
    grammar: { extensionId: "vscode.groovy" },
    background: "#272822",
    removedExtensionDefault: true,
    iconStyles: 1,
  });
  expect((await snapshot()).tokens.some((token: string) => token.includes(" "))).toBe(true);
  const loaded = await snapshot();
  await page.screenshot({ path: join(root, "loaded.png") });
  await page.evaluate(async () =>
    (await import("/tests/vscode-content-refresh.fixture.ts")).suggest("pl"),
  );
  const snippet = page
    .locator(".suggest-widget.visible .monaco-list-row")
    .filter({ has: page.locator(".label-name", { hasText: /^pl$/ }) });
  await expect(snippet).toHaveCount(1);
  await snippet.click();
  await expect.poll(async () => (await snapshot()).text).toBe("println ");
  const first = await snapshot();
  await page.evaluate(async (directory) => {
    const fixture = await import("/tests/vscode-content-refresh.fixture.ts");
    await Promise.all([fixture.scan(directory), fixture.scan(directory), fixture.scan(directory)]);
  }, extensions);
  await expect.poll(snapshot).toMatchObject({
    session: before.session,
    language: "groovy",
    background: "#272822",
    iconStyles: 1,
  });
  await expect.poll(async () => (await snapshot()).generation).toBeGreaterThan(first.generation);
  await expect.poll(async () => (await snapshot()).theme).not.toBe(first.theme);
  await page.evaluate(async () =>
    (await import("/tests/vscode-content-refresh.fixture.ts")).suggest("pl"),
  );
  await expect(snippet).toHaveCount(1);
  await page.keyboard.press("Escape");
  manifest.contributes.snippets = [];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const repeated = await snapshot();
  await page.evaluate(
    async (directory) => (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
    extensions,
  );
  await expect.poll(snapshot).toMatchObject({ snippets: [], background: "#272822", iconStyles: 1 });
  await expect.poll(async () => (await snapshot()).theme).not.toBe(repeated.theme);
  await page.evaluate(async () =>
    (await import("/tests/vscode-content-refresh.fixture.ts")).suggest("foreign"),
  );
  const foreign = page
    .locator(".suggest-widget.visible .monaco-list-row")
    .filter({ hasText: "foreign-provider" });
  await expect(foreign).toHaveCount(1);
  await foreign.click();
  await expect.poll(async () => (await snapshot()).text).toBe("foreign-provider");
  const foreignText = (await snapshot()).text;
  await page.evaluate(async () =>
    (await import("/tests/vscode-content-refresh.fixture.ts")).suggest("pl"),
  );
  await expect(snippet).toHaveCount(0);
  await page.keyboard.press("Escape");
  const themePath = join(extensions, "theme-monokai/themes/monokai-color-theme.json");
  const theme = readFileSync(themePath, "utf8");
  writeFileSync(themePath, "{ invalid theme");
  await page.evaluate(
    async (directory) => (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
    extensions,
  );
  await expect(
    page
      .locator(".ui-notification-message")
      .filter({ hasText: /Extension contributions: Invalid JSONC contribution/ }),
  ).toBeVisible();
  writeFileSync(themePath, theme);
  await page.evaluate(
    async (directory) => (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
    extensions,
  );
  await expect
    .poll(snapshot)
    .toMatchObject({ session: before.session, background: "#272822", iconStyles: 1 });
  const after = await snapshot();
  expect(after).toMatchObject({ session: before.session, background: "#272822", iconStyles: 1 });
  const remove = () =>
    page.evaluate(
      async (id) => (await import("/tests/vscode-content-refresh.fixture.ts")).removeExtension(id),
      monokaiId,
    );
  expect(await remove()).toBe(true);
  await expect.poll(snapshot).toMatchObject({
    session: before.session,
    language: "groovy",
    grammar: { extensionId: "vscode.groovy" },
    removedExtensionDefault: false,
    iconStyles: 1,
  });
  await expect.poll(async () => (await snapshot()).background).not.toBe("#272822");
  expect(await remove()).toBe(false);
  expect(existsSync(monokaiManifestPath)).toBe(true);
  await page.evaluate(
    async (directory) => (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
    extensions,
  );
  await expect.poll(snapshot).toMatchObject({
    session: before.session,
    background: "#272822",
    removedExtensionDefault: true,
  });
  await page.screenshot({ path: join(root, "editor.png") });
  const report = {
    before,
    loaded,
    insertedSnippet: first.text,
    foreignText,
    after,
    browserErrors: await errors(),
  };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  expect(report.browserErrors).toEqual([]);
});

for (const replace of [false, true])
  test(`${replace ? "replacing" : "unregistering"} the real extension client during content loading releases only its queued adapter`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const builtins =
      process.env.HARNESS_VSCODE_BUILTINS_DIR ??
      "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
    test.skip(
      !existsSync(join(builtins, "theme-monokai/package.json")),
      "Requires installed VS Code contribution resources",
    );
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    const extensions = mkdtempSync(join(artifacts, "content-dispose-"));
    for (const name of ["groovy", "theme-monokai", "theme-seti"])
      cpSync(join(builtins, name), join(extensions, name), { recursive: true });
    const seed = await context.newPage();
    await seed.goto("/");
    await expect(seed.getByText("Search commands", { exact: true })).toBeVisible();
    await seed.evaluate(
      async (directory) =>
        (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
      extensions,
    );
    const errors = await captureBrowserErrors(page);
    let requested = false;
    let release = () => {};
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/onig\.wasm(?:\?.*)?$/, async (route) => {
      if (route.request().resourceType() === "fetch") {
        requested = true;
        await resumed;
      }
      await route.continue();
    });
    try {
      await page.goto("/");
      await expect.poll(() => requested).toBe(true);
      if (replace) {
        const manifestPath = join(extensions, "groovy/package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.contributes.grammars = [];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        await seed.evaluate(
          async (directory) =>
            (await import("/tests/vscode-content-refresh.fixture.ts")).scan(directory),
          extensions,
        );
      }
      await page.evaluate(
        async (replace) =>
          (await import("/tests/vscode-content-refresh.fixture.ts")).unregisterClient(replace),
        replace,
      );
      if (replace)
        await expect
          .poll(() =>
            page.evaluate(async () =>
              (await import("/tests/vscode-content-refresh.fixture.ts")).replacementQueued(),
            ),
          )
          .toBe(true);
      release();
      const state = await page.evaluate(
        async (replace) =>
          (await import("/tests/vscode-content-refresh.fixture.ts")).disposedState(replace),
        replace,
      );
      expect(state).toEqual(
        replace
          ? { active: true, background: "#272822", iconStyles: 1 }
          : { active: false, background: "", iconStyles: 0 },
      );
      expect(await errors()).toEqual([]);
    } finally {
      release();
      await seed.close();
    }
  });
