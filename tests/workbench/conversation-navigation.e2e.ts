import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`workspace actions share their size and alignment at ${width}px`, async ({ page }, testInfo) => {
    const folder = testInfo.outputPath("aligned-actions");
    await mkdir(folder, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const primarySidebar = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
    await expect(primarySidebar).toBeVisible();
    if ((await primarySidebar.getAttribute("aria-pressed")) === "false") {
      await primarySidebar.click();
    }
    const open = page.getByRole("button", { name: "Open folder as workspace", exact: true });
    await expect(open).toBeVisible();
    const workspace = await page.evaluate(
      async (root) =>
        (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
      folder,
    );

    try {
      const row = page
        .getByRole("tree", { name: "Conversations", exact: true })
        .locator(`[data-id="workspace:${workspace.workspaceId}"]`);
      const add = row.getByRole("button", { name: "New conversation here", exact: true });
      await expect(add).toBeVisible();
      await expect(open.locator("span")).toHaveCSS("font-size", "14px");
      await expect(add.locator("span")).toHaveCSS("font-size", "16px");
      await expect.poll(async () => {
        const titleAction = (await open.boundingBox())!;
        const rowAction = (await add.boundingBox())!;
        return {
          width: rowAction.width - titleAction.width,
          height: rowAction.height - titleAction.height,
          center: rowAction.x + rowAction.width / 2 - titleAction.x - titleAction.width / 2,
        };
      }).toEqual({ width: 0, height: 0, center: 0 });

      const actionBounds = (await add.boundingBox())!;
      const rowBounds = (await row.boundingBox())!;
      expect(actionBounds.y).toBeGreaterThanOrEqual(rowBounds.y);
      expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
        rowBounds.y + rowBounds.height,
      );

      await open.hover();
      const titleHover = await open.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, radius: style.borderRadius };
      });
      await add.hover();
      await expect(add).toHaveCSS("background-color", titleHover.background);
      await expect(add).toHaveCSS("color", titleHover.color);
      await expect(add).toHaveCSS("border-radius", titleHover.radius);
    } finally {
      await page.evaluate(
        async (created) =>
          (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(created),
        workspace,
      );
    }
  });
}

test("conversation navigator opens folders and exposes workspace and conversation actions", async ({
  page,
}, testInfo) => {
  const name = `workspace-${crypto.randomUUID().slice(0, 8)}`;
  const folder = testInfo.outputPath(name);
  await mkdir(folder, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  const navigation = page.getByRole("region", { name: "Conversations", exact: true });
  const tree = navigation.getByRole("tree", { name: "Conversations", exact: true });
  const titleHeader = navigation.locator(".workbench-view-header");
  const controls = titleHeader.getByRole("toolbar", { name: "Conversations actions", exact: true });
  await expect(
    titleHeader.getByRole("heading", { name: "Conversations", exact: true }),
  ).toBeVisible();
  await expect(controls.getByRole("button")).toHaveCount(1);
  await expect(
    navigation.getByRole("button", { name: "New conversation", exact: true }),
  ).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: /search|filter/i })).toHaveCount(0);
  await expect(navigation.getByRole("textbox", { name: /search|filter/i })).toHaveCount(0);
  await controls.getByRole("button", { name: "Open folder as workspace", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Open Folder as Workspace" });
  await expect(picker.getByRole("listbox")).toHaveAttribute("aria-busy", "false", {
    timeout: 15000,
  });
  await picker.getByRole("combobox", { name: "Path", exact: true }).fill(folder);
  await picker.getByRole("option", { name, exact: true }).click();
  await expect(
    picker
      .getByRole("navigation", { name: "Path breadcrumbs" })
      .getByRole("button", { name, exact: true }),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Open Folder", exact: true }).click();
  await expect(picker).toHaveCount(0);

  const group = tree.getByRole("treeitem", { name: new RegExp(`^${name}\\b`) });
  const add = group.getByRole("button", { name: "New conversation here", exact: true });
  await page.mouse.move(4, 4);
  await expect(add).toBeVisible();
  await add.click();
  const created = tree
    .getByRole("treeitem", { name: /^New conversation\b/, selected: true })
    .and(tree.locator('[aria-level="2"]'));
  await expect(created).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(group).toHaveAttribute("aria-selected", "false");
  await expect(group.getByRole("button")).toHaveCount(1);
  await expect(add).toBeVisible();
  await expect(
    tree.getByRole("button", { name: /^Actions for /, includeHidden: true }),
  ).toHaveCount(0);
  await created.click({ button: "right" });
  const conversationMenu = page.getByRole("menu", {
    name: "Actions for New conversation",
    exact: true,
  });
  const rowTop = (await created.boundingBox())!.y;
  await expect
    .poll(async () => Math.abs(((await conversationMenu.boundingBox())?.y ?? Infinity) - rowTop))
    .toBeLessThan(24);
  await conversationMenu.getByRole("menuitem", { name: /Rename conversation/ }).click();
  const rename = created.getByRole("textbox", { name: "Conversation title" });
  const title = `Conversation in ${name}`;
  await rename.fill(title);
  await rename.press("Enter");

  const renamed = tree.getByRole("treeitem", { name: new RegExp(`^${title}\\b`) });
  await expect(renamed).toBeVisible();
  await tree.press("ArrowLeft");
  await tree.press("ArrowLeft");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(renamed).toHaveCount(0);

  await tree.press("ArrowRight");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(renamed).toBeVisible();

  await group.click({ button: "right" });
  const workspaceMenu = page.getByRole("menu", { name: `Actions for ${name}`, exact: true });
  page.once("dialog", (dialog) => dialog.accept());
  await workspaceMenu.getByRole("menuitem", { name: "Delete workspace…", exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("narrow conversation navigator fits its pane and exposes row actions by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 600 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Workbench views" })
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  const navigation = page.getByRole("region", { name: "Conversations", exact: true });
  const controls = navigation.getByRole("toolbar", { name: "Conversations actions", exact: true });
  await expect(controls.getByRole("button", { name: "Open folder as workspace" })).toBeInViewport();
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">New conversation");
  await page.keyboard.press("Enter");
  const tree = navigation.getByRole("tree", { name: "Conversations", exact: true });
  const row = tree.getByRole("treeitem", { name: /^New conversation\b/, selected: true });
  await expect(row).toBeVisible();
  const pane = (await navigation.boundingBox())!;
  await expect
    .poll(async () => {
      const box = (await tree.boundingBox())!;
      return Math.round(box.y + box.height - pane.y - pane.height);
    })
    .toBe(0);

  await page.mouse.move(4, 4);
  await tree.focus();
  await tree.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions for New conversation", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Open in new tab", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tree).toBeFocused();
  await expect(tree).toHaveAttribute("aria-activedescendant", (await row.getAttribute("id")) ?? "");

  await tree.press("Shift+F10");
  page.once("dialog", (dialog) => dialog.dismiss());
  await menu.getByRole("menuitem", { name: "Delete conversation…", exact: true }).click();
  await expect(row).toBeVisible();

  await row.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Open in new tab", exact: true }).click();
  await expect(page.getByRole("tab", { name: "New conversation", exact: true })).toBeVisible();
});
