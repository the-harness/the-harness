import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExtensionContributions } from "../../packages/vscode-ext-host/src/contributions.ts";
import { readExtensionManifest } from "../../packages/vscode-ext-host/src/manifest.ts";

const builtins =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

test("icon adapter renders the official Seti glyph and resolves file mappings", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(builtins, "theme-seti/package.json")),
    "Requires the installed VS Code Seti theme",
  );
  const manifest = await readExtensionManifest(join(builtins, "theme-seti"));
  const typescript = await readExtensionManifest(join(builtins, "typescript-basics"));
  const snapshots = await readExtensionContributions([manifest!, typescript!]);
  const data = JSON.parse(
    readFileSync(join(builtins, "theme-seti/icons/vs-seti-icon-theme.json"), "utf8"),
  );
  await page.route("**/icon-audit", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><head></head><body></body></html>",
    }),
  );
  await page.goto("/icon-audit");
  const result = await page.evaluate(async (snapshots) => {
    const fixture = await import("/tests/vscode-file-icons.fixture.ts");
    await fixture.installIcons(snapshots);
    return {
      icon: await fixture.inspectIcon("example.ts"),
      readme: fixture.iconClass("README.md"),
      file: fixture.iconClass("example.ts"),
      unknown: fixture.iconClass("example.unknown"),
    };
  }, snapshots);
  const expected = String.fromCodePoint(
    parseInt(data.iconDefinitions[data.languageIds.typescript].fontCharacter.slice(1), 16),
  );
  expect(result.icon.content).toBe(JSON.stringify(expected));
  expect(result.icon.loaded).toBe(true);
  expect(result.icon.fontSize).toBe("24px");
  expect(result.readme?.endsWith(data.fileNames["readme.md"])).toBe(true);
  expect(result.file?.endsWith(data.languageIds.typescript)).toBe(true);
  expect(result.unknown?.endsWith(data.file)).toBe(true);
});

test("icon adapter distinguishes extension names from definitions and escapes literal characters", async ({
  page,
}) => {
  const data = {
    fonts: [{ id: "test", src: [], size: "150%" }],
    iconDefinitions: {
      ts: { fontCharacter: "x" },
      target: { fontCharacter: '";color:red;/*' },
      file: { fontCharacter: "f" },
      closed: { fontCharacter: "c" },
      opened: { fontCharacter: "o" },
      root: { fontCharacter: "r" },
      rootOpen: { fontCharacter: "R" },
      named: { fontCharacter: "n" },
      namedOpen: { fontCharacter: "N" },
    },
    file: "file",
    fileNames: { "special.ts": "file" },
    fileExtensions: { ts: "target" },
    folder: "closed",
    folderExpanded: "opened",
    rootFolder: "root",
    rootFolderExpanded: "rootOpen",
    folderNames: { src: "named", docs: "named" },
    folderNamesExpanded: { src: "namedOpen" },
    rootFolderNames: { workspace: "named" },
    rootFolderNamesExpanded: { workspace: "namedOpen" },
    light: { fileNames: { "light.ts": "target" } },
  };
  const snapshots = [
    {
      id: "test.icons",
      contributes: { iconThemes: [{ id: "test", label: "test", path: "icons.json" }] },
      resources: {
        "icons.json": {
          contents: JSON.stringify(data),
          encoding: "utf8",
          mimeType: "application/json",
        },
      },
      errors: [],
    },
  ];
  await page.route("**/icon-audit", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><head></head><body></body></html>",
    }),
  );
  await page.goto("/icon-audit");
  const result = await page.evaluate(async (snapshots) => {
    const fixture = await import("/tests/vscode-file-icons.fixture.ts");
    await fixture.installIcons(snapshots as any, { themeKind: "light" });
    fixture.selectIconTheme("test");
    return {
      lightFile: fixture.iconClass("light.ts"),
      icon: await fixture.inspectIcon("sample.ts"),
      namedFile: fixture.iconClass("special.ts"),
      folder: fixture.iconClass("src", { folder: true }),
      folderOpen: fixture.iconClass("src", { folder: true, expanded: true }),
      root: fixture.iconClass("workspace", { folder: true, root: true }),
      rootOpen: fixture.iconClass("workspace", { folder: true, root: true, expanded: true }),
      genericRoot: fixture.iconClass("other", { folder: true, root: true }),
      namedOpenFallback: fixture.iconClass("docs", { folder: true, expanded: true }),
    };
  }, snapshots);
  expect(result.lightFile?.endsWith("-target")).toBe(true);
  expect(result.icon.className?.endsWith("-target")).toBe(true);
  expect(result.icon.content).toBe(JSON.stringify(data.iconDefinitions.target.fontCharacter));
  expect(result.namedFile?.endsWith("-file")).toBe(true);
  expect(result.folder?.endsWith("-named")).toBe(true);
  expect(result.folderOpen?.endsWith("-namedOpen")).toBe(true);
  expect(result.root?.endsWith("-named")).toBe(true);
  expect(result.rootOpen?.endsWith("-namedOpen")).toBe(true);
  expect(result.genericRoot?.endsWith("-root")).toBe(true);
  expect(result.namedOpenFallback?.endsWith("-named")).toBe(true);
});

test("Seti icons update in the production file tree and editor tab when the color theme changes", async ({
  page,
}) => {
  test.skip(
    !existsSync(join(builtins, "theme-seti/package.json")),
    "Requires installed VS Code themes",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "icon-extension-"));
  const extension = join(root, "root-theme");
  mkdirSync(extension);
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "root-theme",
      publisher: "test",
      version: "1.0.0",
      contributes: { iconThemes: [{ id: "root-test", label: "Root test", path: "icons.json" }] },
    }),
  );
  writeFileSync(
    join(extension, "icons.json"),
    JSON.stringify({
      iconDefinitions: { root: { fontCharacter: "r" }, open: { fontCharacter: "o" } },
      rootFolder: "root",
      rootFolderExpanded: "open",
    }),
  );
  const data = JSON.parse(
    readFileSync(join(builtins, "theme-seti/icons/vs-seti-icon-theme.json"), "utf8"),
  );
  await page.goto("/");
  const row = page.getByRole("treeitem", { name: "package.json, has actions", exact: true });
  await expect(row).toBeVisible();
  const scanned = await page.evaluate(
    async ({ builtins, root }) => {
      const fixture = await import("/tests/vscode-file-icons.fixture.ts");
      const scanned = await fixture.scanAndRefresh(builtins, root);
      fixture.configureAppearance("Dark+", "vs-seti");
      return scanned;
    },
    { builtins, root },
  );
  expect(scanned.official).toContain("vscode.vscode-theme-seti");
  expect(scanned.official).toContain("vscode.json");
  expect(scanned.custom).toContain("test.root-theme");
  const rowIcon = row.locator(".vc-tree-node-icon");
  await expect(rowIcon).toHaveClass(new RegExp(`${data.languageIds.json}$`));
  await row.click();
  const tabIcon = page
    .getByRole("tab", { name: "package.json", exact: true })
    .locator(".workbench-tab-icon");
  await expect(tabIcon).toHaveClass(new RegExp(`${data.languageIds.json}$`));
  const expected = String.fromCodePoint(
    parseInt(data.iconDefinitions[data.languageIds.json].fontCharacter.slice(1), 16),
  );
  for (const icon of [rowIcon, tabIcon]) {
    await expect
      .poll(() => icon.evaluate((element) => getComputedStyle(element, "::before").content))
      .toBe(JSON.stringify(expected));
  }
  await page.evaluate(async () =>
    (await import("/tests/vscode-file-icons.fixture.ts")).configureAppearance("Light+", "vs-seti"),
  );
  await expect(rowIcon).toHaveClass(new RegExp(`${data.light.languageIds.json}$`));
  await expect(tabIcon).toHaveClass(new RegExp(`${data.light.languageIds.json}$`));
  await page.screenshot({ path: "temp/artifacts/icons-production.png" });
  await page.evaluate(async () =>
    (await import("/tests/vscode-file-icons.fixture.ts")).configureAppearance(
      "Light+",
      "root-test",
    ),
  );
  const rootRow = page.getByRole("treeitem", { name: "web, has actions", exact: true });
  await expect(rootRow.locator(".vc-tree-node-icon")).toHaveClass(/-open$/);
  await rootRow.locator(".vc-tree-twistie").click();
  await expect(rootRow.locator(".vc-tree-node-icon")).toHaveClass(/-root$/);
});
