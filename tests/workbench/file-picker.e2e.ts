import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("file picker modal opens from workspace panel and browses directories", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("picker-workspace");
  const openedRoot = join(root, "nested");
  const additionalRoot = testInfo.outputPath("additional-folder", "nested");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(additionalRoot, { recursive: true })]);
  await writeFile(join(additionalRoot, "notes.txt"), "Notes");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/tests/explorer-expanded-refresh.fixture.html");
  await page.evaluate(async () => {
    (await import("/tests/explorer-expanded-refresh.fixture.ts")).mountFilesPicker();
  });

  const panel = page.locator(".files-panel");
  await expect(panel.getByRole("button", { includeHidden: true })).toHaveCount(1);
  await panel.getByRole("button", { name: "Open Folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open Folder", exact: true });
  const pathInput = dialog.getByRole("combobox", { name: "Path", exact: true });
  await expect(pathInput).not.toHaveValue("");
  await expect(dialog.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
  await pathInput.fill(root);

  const entry = dialog.getByRole("option", { name: "picker-workspace", exact: true });
  await entry.dblclick();
  await dialog.getByRole("button", { name: "New Folder", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New folder name", exact: true }).fill("nested");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(
    dialog
      .getByRole("navigation", { name: "Path breadcrumbs" })
      .getByText("nested", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Open Folder", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  const tree = panel.getByRole("tree", { name: "Explorer", exact: true });
  const nestedRoot = (path: string) =>
    tree.getByRole("treeitem", { name: `nested, ${path}`, exact: true });
  const opened = nestedRoot(openedRoot);
  const added = nestedRoot(additionalRoot);
  const folderMenu = page.getByRole("menu", { name: "Actions for nested", exact: true });
  const remove = folderMenu.getByRole("menuitem", {
    name: "Remove Folder from Workspace",
    exact: true,
  });
  await expect(opened).toBeVisible();
  expect((await stat(openedRoot)).isDirectory()).toBe(true);

  const addDialog = page.getByRole("dialog", { name: "Add Folder to Workspace", exact: true });
  const browseAdditional = async () => {
    await opened.click({ button: "right" });
    await expect(remove).toHaveCount(0);
    await folderMenu
      .getByRole("menuitem", { name: "Add Folder to Workspace…", exact: true })
      .click();
    await expect(addDialog.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
    await addDialog.getByRole("combobox", { name: "Path", exact: true }).fill(additionalRoot);
    await addDialog.getByRole("option", { name: "nested", exact: true }).click();
    await expect(
      addDialog
        .getByRole("navigation", { name: "Path breadcrumbs" })
        .getByText("additional-folder", {
          exact: true,
        }),
    ).toBeVisible();
  };

  await browseAdditional();
  await addDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(addDialog).toHaveCount(0);
  await expect(opened).toBeVisible();
  await expect(added).toHaveCount(0);

  await browseAdditional();
  await addDialog.getByRole("button", { name: "Add Folder", exact: true }).click();
  await expect(addDialog).toHaveCount(0);
  await expect(opened.getByText(openedRoot, { exact: true })).toBeVisible();
  await expect(added.getByText(additionalRoot, { exact: true })).toBeVisible();
  const notes = tree.getByRole("treeitem", { name: /^notes\.txt\b/ });
  await expect(notes).toBeVisible();

  const collapse = panel.getByRole("button", { name: "Collapse Folders", exact: true });
  await collapse.click();
  await expect(collapse).toBeDisabled();
  await expect(notes).toHaveCount(0);

  await added.click();
  await expect(notes).toBeVisible();
  await expect(collapse).toBeEnabled();
  await added.click({ button: "right" });
  await remove.click();
  await expect(added).toHaveCount(0);
  await expect(opened).toBeVisible();
  await expect(collapse).toBeDisabled();
  await opened.click({ button: "right" });
  await expect(folderMenu).toBeVisible();
  await expect(remove).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await stat(additionalRoot)).isDirectory()).toBe(true);
  expect(errors).toEqual([]);
});

test("file picker context menus keep the dialog open and focus the requested action", async ({ page }, testInfo) => {
  const root = testInfo.outputPath("context-folder");
  await mkdir(root, { recursive: true });
  await page.goto("/tests/explorer-expanded-refresh.fixture.html");
  await page.evaluate(async () => (await import("/tests/explorer-expanded-refresh.fixture.ts")).mountFilesPicker());
  await page.getByRole("button", { name: "Open Folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open Folder", exact: true });
  const path = dialog.getByRole("combobox", { name: "Path", exact: true });
  await expect(dialog.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
  await path.fill(root);
  const folder = dialog.getByRole("option", { name: "context-folder", exact: true });
  await folder.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "File picker actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Open Folder", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(folder).toBeFocused();
  await folder.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Open Folder", exact: true }).click();
  await expect(dialog.getByRole("navigation", { name: "Path breadcrumbs" }).getByText("context-folder", { exact: true })).toBeVisible();
  await dialog.getByRole("listbox").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "New Folder…", exact: true }).click();
  const input = dialog.getByRole("textbox", { name: "New folder name", exact: true });
  await expect(input).toBeFocused();
  await input.press("Escape");
  await path.click({ button: "right" });
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
});
