import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

test("renaming an open file in Explorer keeps its dirty editor and saves under the new name", async ({
  page,
}, testInfo) => {
  await verifyRename(page, "Explorer", testInfo.outputPath("file-rename"));
});

for (const mode of ["foreground", "background"] as const) {
  test(`renaming an open file through a ${mode} extension workspace preserves its working copy`, async ({
    page,
  }, testInfo) => {
    await verifyRename(page, mode, testInfo.outputPath("file-rename"));
  });
}

async function verifyRename(
  page: Page,
  entryPoint: "Explorer" | "foreground" | "background",
  root: string,
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const original = join(root, "before-rename.ts");
  const renamed = join(root, "after-rename.ts");
  const initialContent = "const initialValue = 1;";
  const editedContent = "const editedValue = 42;";
  writeFileSync(original, initialContent);

  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const workspace = await page.evaluate(
    async (root) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
    root,
  );
  try {
    const explorer = page.getByRole("tree", { name: "Explorer", exact: true });
    const originalRow = explorer.getByRole("treeitem", { name: "before-rename.ts", exact: true });
    await originalRow.click();
    const view = page.locator(".file-editor-monaco .monaco-editor");
    await expect(view.locator(".view-lines")).toContainText("initialValue");
    const editor = await view.elementHandle();
    await view.locator(".view-lines").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(editedContent);
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    expect(readFileSync(original, "utf8")).toBe(initialContent);

    if (entryPoint === "Explorer") {
      const menu = page.getByRole("menu", { name: "Actions for before-rename.ts", exact: true });
      const input = explorer.getByRole("textbox", { name: "Rename to", exact: true });
      const beginRename = async () => {
        await originalRow.click({ button: "right" });
        await expect(menu.getByRole("menuitem", { name: "Copy Path", exact: true })).toBeVisible();
        await expect(
          menu.getByRole("menuitem", { name: "Copy Relative Path", exact: true }),
        ).toBeVisible();
        await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
        await expect(input).toBeFocused();
        await expect(input).toHaveValue("before-rename.ts");
      };
      await expect(originalRow.getByRole("button", { includeHidden: true })).toHaveCount(0);
      await beginRename();
      await input.fill("cancelled.ts");
      await input.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(originalRow).toBeVisible();
      expect(existsSync(join(root, "cancelled.ts"))).toBe(false);

      await beginRename();
      await input.fill("invalid/name.ts");
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await view.locator(".view-lines").click();
      await expect(input).toHaveCount(0);
      await expect(originalRow).toBeVisible();
      expect(existsSync(join(root, "invalid"))).toBe(false);

      await beginRename();
      await input.fill("after-rename.ts");
      await view.locator(".view-lines").click();
    } else {
      await page.evaluate(
        async ({ root, source, target, foreground }) =>
          (await import("/tests/vscode-reopen-editor.fixture.ts")).renameFromExtensionHost(
            root,
            source,
            target,
            foreground,
          ),
        { root, source: original, target: renamed, foreground: entryPoint === "foreground" },
      );
    }

    await expect(
      explorer.getByRole("treeitem", { name: "after-rename.ts", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /after-rename\.ts/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /before-rename\.ts/ })).toHaveCount(0);
    expect(await view.evaluate((element, previous) => element === previous, editor)).toBe(true);
    await expect(view.locator(".view-lines")).toContainText("editedValue");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    expect(readFileSync(renamed, "utf8")).toBe(initialContent);

    await page.getByRole("button", { name: "Save (Cmd+S)", exact: true }).click();
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
    expect(readFileSync(renamed, "utf8")).toBe(editedContent);
    expect(existsSync(original)).toBe(false);

    writeFileSync(original, "const differentFile = true;");
    await page
      .locator(".files-toolbar")
      .getByRole("button", { name: "Refresh Explorer", exact: true })
      .click();
    await originalRow.click();
    await expect(page.getByRole("tab", { name: /before-rename\.ts/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /after-rename\.ts/ })).toBeVisible();
    await expect(view.locator(".view-lines").filter({ hasText: "differentFile" })).toBeVisible();
  } finally {
    await page.evaluate(async (workspace) => {
      (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace);
    }, workspace);
  }
}
