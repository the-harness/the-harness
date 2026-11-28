import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

const builtins =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ?? process.env.HARNESS_VSCODE_BUILTINS_DIR;

test("normal web startup loads configured official builtins into the real editor", async ({
  page,
}) => {
  test.setTimeout(90_000);
  test.skip(
    !builtins || !existsSync(join(builtins, "powershell/package.json")),
    "Set HARNESS_VSCODE_BUILTINS_DIR to the installed VS Code extensions directory",
  );
  const getBrowserErrors = await captureBrowserErrors(page);
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-startup-"));
  const name = "startup.ps1";
  writeFileSync(join(root, name), 'function Get-Greeting { Write-Host "Hello" }\n');
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  const snapshots = await page.evaluate(async () =>
    (await import("/tests/vscode-builtin-startup.fixture.ts")).serverContributions(),
  );
  expect(snapshots).toHaveLength(95);
  expect(snapshots.map((snapshot: { id: string }) => snapshot.id)).toContain("vscode.powershell");
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await import("/tests/vscode-builtin-startup.fixture.ts")).contributionState(),
        ),
      { timeout: 30_000 },
    )
    .toMatchObject({ grammar: { extensionId: "vscode.powershell" } });
  await page.evaluate(
    async ({ root, name }) =>
      (await import("/tests/vscode-builtin-startup.fixture.ts")).openDocument(root, name),
    { root, name },
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          async (path) =>
            (await import("/tests/vscode-builtin-startup.fixture.ts")).editorState(path),
          join(root, name),
        ),
      { timeout: 15_000 },
    )
    .toMatchObject({ language: "powershell" });
  const editor = await page.evaluate(
    async (path) => (await import("/tests/vscode-builtin-startup.fixture.ts")).editorState(path),
    join(root, name),
  );
  expect(editor.tokens.some((token: string) => token.includes(" "))).toBe(true);
  expect(editor.text).toContain("Get-Greeting");
  await page.screenshot({ path: join(root, "editor.png") });
  const report = {
    configuredDirectory: builtins,
    contributionCount: snapshots.length,
    contributions: await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-startup.fixture.ts")).contributionState(),
    ),
    editor,
    browserErrors: await getBrowserErrors(),
  };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  expect(report.browserErrors).toEqual([]);
});
