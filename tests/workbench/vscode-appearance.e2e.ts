import { expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("workbench settings select contributed color and file icon themes and restore them after reload", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const openSettingsInEditor = async () => {
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  };
  const builtins =
    process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
    process.env.HARNESS_VSCODE_BUILTINS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(
    !existsSync(join(builtins, "theme-monokai/package.json")),
    "Requires official VS Code theme resources",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "appearance-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const name of readdirSync(builtins).filter((name) => name.startsWith("theme-")))
    cpSync(join(builtins, name), join(extensions, name), { recursive: true });
  writeFileSync(join(root, "appearance.ts"), "const appearance = true;\n");
  const errors = await captureBrowserErrors(page);
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  await page.evaluate(
    async (directory) =>
      (await import("/tests/vscode-appearance.fixture.ts")).loadThemes(directory),
    extensions,
  );
  await page.evaluate(
    async (root) => (await import("/tests/vscode-appearance.fixture.ts")).openDocument(root),
    root,
  );
  await openSettingsInEditor();
  const colors = page.getByRole("combobox", { name: /Color theme/ });
  const icons = page.getByRole("combobox", { name: "File icon theme", exact: true });
  await expect(colors).toHaveText("Default");
  await colors.click();
  const colorOptions = page.getByRole("listbox", { name: "Color theme" });
  await expect(colorOptions.getByRole("option")).toHaveCount(20);
  await colorOptions.getByRole("option", { name: "Monokai", exact: true }).click();
  await colors.click();
  await colorOptions.getByRole("option", { name: "Default", exact: true }).click();
  await expect(colors).toHaveText("Default");
  await colors.click();
  await colorOptions.getByRole("option", { name: "Monokai", exact: true }).click();
  await page.getByRole("tab", { name: "appearance.ts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const background = document.querySelector(".monaco-editor-background");
        return background ? getComputedStyle(background).backgroundColor : undefined;
      }),
    )
    .toBe("rgb(39, 40, 34)");
  await openSettingsInEditor();
  await icons.click();
  await page
    .getByRole("listbox", { name: "File icon theme" })
    .getByRole("option", { name: "VS Code Modern Icons", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('[class*="vscode-contribution-"][class*="-icon-"]')].some(
          (element) =>
            getComputedStyle(element).backgroundImage.startsWith('url("data:image/svg+xml'),
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => (await import("/tests/vscode-appearance.fixture.ts")).snapshot()),
    )
    .toMatchObject({ selectedTheme: "Monokai", selectedIcons: "vscode-modern-icons" });
  await page.reload();
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  await openSettingsInEditor();
  await expect(colors).toHaveText("Monokai");
  await expect(icons).toHaveText("VS Code Modern Icons");
  await expect
    .poll(() =>
      page.evaluate(async () => (await import("/tests/vscode-appearance.fixture.ts")).snapshot()),
    )
    .toMatchObject({ appliedTheme: expect.stringContaining("Monokai") });
  await page.screenshot({ path: join(root, "settings.png") });
  expect(await errors()).toEqual([]);
});
