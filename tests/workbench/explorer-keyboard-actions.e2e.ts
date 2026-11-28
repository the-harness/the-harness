import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

for (const { key, action, inputLabel, item } of [
  { key: "Enter", action: "New File", inputLabel: "New file name", item: "created.txt" },
  { key: "Space", action: "New Folder", inputLabel: "New folder name", item: "created-directory" },
]) {
  test(`${key} runs the focused ${action} action in Explorer`, async ({ page }, testInfo) => {
    const root = testInfo.outputPath("explorer-project");
    await mkdir(root, { recursive: true });
    const tree = await mountExplorer(page, root);
    const rootRow = tree.getByRole("treeitem", { name: /^explorer-project\b/ });
    await expect(rootRow).toBeVisible();
    await tree.focus();
    await expect(tree).toHaveAttribute(
      "aria-activedescendant",
      (await rootRow.getAttribute("id"))!,
    );
    await page.keyboard.press("Enter");
    await expect(rootRow).toHaveAttribute("aria-selected", "true");

    await tree.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Actions for explorer-project", exact: true });
    await menu.getByRole("menuitem", { name: action, exact: true }).press(key);
    await expect(menu).toHaveCount(0);
    const input = tree.getByRole("textbox", { name: inputLabel, exact: true });
    await expect(input).toBeFocused();
    await input.fill(item);
    await input.press("Enter");

    await expect(tree.getByRole("treeitem", { name: item, exact: true })).toBeVisible();
    expect((await stat(join(root, item))).isDirectory()).toBe(key === "Space");
  });
}

test("Explorer toolbar creates items in the focused folder or file's parent", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("explorer-project");
  const docs = join(root, "docs");
  const src = join(root, "src");
  await Promise.all([mkdir(docs, { recursive: true }), mkdir(src, { recursive: true })]);
  await writeFile(join(src, "anchor.txt"), "Anchor");

  const tree = await mountExplorer(page, root);
  const toolbar = page.locator(".files-toolbar");
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  const buttons = await toolbar.getByRole("button").all();
  expect(await Promise.all(buttons.map((button) => button.getAttribute("aria-label")))).toEqual([
    "New File",
    "New Folder",
    "Refresh Explorer",
    "Collapse Folders",
  ]);

  await tree.getByRole("treeitem", { name: "docs", exact: true }).click();
  await toolbar.getByRole("button", { name: "New File", exact: true }).click();
  const fileInput = tree.getByRole("textbox", { name: "New file name", exact: true });
  await fileInput.fill("readme.txt");
  await fileInput.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "readme.txt", exact: true })).toBeVisible();
  expect((await stat(join(docs, "readme.txt"))).isFile()).toBe(true);

  const source = tree.getByRole("treeitem", { name: "src", exact: true });
  const anchor = tree.getByRole("treeitem", { name: "anchor.txt", exact: true });
  await source.click();
  await expect(anchor).toBeVisible();
  await source.dblclick();
  await expect(anchor).toHaveCount(0);
  await source.click();
  await anchor.click();
  await toolbar.getByRole("button", { name: "New Folder", exact: true }).click();
  const folderInput = tree.getByRole("textbox", { name: "New folder name", exact: true });
  await folderInput.fill("generated");
  await folderInput.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "generated", exact: true })).toBeVisible();
  expect((await stat(join(src, "generated"))).isDirectory()).toBe(true);
});

async function mountExplorer(page: Page, root: string) {
  await page.goto("/tests/explorer-expanded-refresh.fixture.html");
  await page.evaluate(
    async (root) =>
      (await import("/tests/explorer-expanded-refresh.fixture.ts")).mountExplorer(root),
    root,
  );
  return page.getByRole("tree", { name: "Explorer", exact: true });
}
