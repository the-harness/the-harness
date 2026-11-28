import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`titlebar brand aligns with the activity bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const brand = page.getByRole("img", { name: "THE HARNESS", exact: true });
    const activity = page.getByRole("navigation", { name: "Workbench views" });
    await expect(brand).toBeVisible();
    await expect(activity).toBeVisible();

    const mark = (await brand.boundingBox())!;
    const rail = (await activity.boundingBox())!;
    const titlebar = (await page.locator("header.titlebar").boundingBox())!;
    const palette = (await page
      .getByRole("button", { name: "Open command palette" })
      .boundingBox())!;
    const controls = (await page.getByRole("group", { name: "Layout controls" }).boundingBox())!;

    expect(mark.x + mark.width / 2).toBeCloseTo(rail.x + rail.width / 2 - 2, 0);
    expect(
      Math.abs(mark.y + mark.height / 2 - (titlebar.y + titlebar.height / 2)),
    ).toBeLessThanOrEqual(1);
    expect(mark.y).toBeGreaterThan(titlebar.y);
    expect(mark.y + mark.height).toBeLessThan(titlebar.y + titlebar.height);
    expect(mark.x + mark.width).toBeLessThan(palette.x);
    expect(palette.x + palette.width).toBeLessThan(controls.x);
    expect(controls.x + controls.width).toBeLessThanOrEqual(width);
  });
}

test("workbench layout controls hide and restore their view areas independently", async ({
  page,
}) => {
  await page.goto("/");
  const layout = page.getByRole("group", { name: "Layout controls" });
  const primary = layout.getByRole("button", { name: "Toggle primary sidebar" });
  const secondary = layout.getByRole("button", { name: "Toggle workspace panel" });
  const conversations = page.getByRole("heading", { name: "Conversations", exact: true });
  const files = page.getByRole("tab", { name: "Files", exact: true });
  const changes = page.getByRole("tab", { name: "Changes", exact: true });
  const activity = page.getByRole("navigation", { name: "Workbench views" });
  const conversationActivity = activity.getByRole("button", { name: "Conversations" });

  await expect(activity.getByRole("button")).toHaveCount(2);
  await expect(activity.getByRole("button", { name: "Manage", exact: true })).toBeVisible();
  await expect(activity.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);
  await expect(conversationActivity.locator("[aria-hidden=true]")).not.toHaveCSS(
    "mask-image",
    "none",
  );
  await expect(page.locator("footer.statusbar").getByText("main", { exact: true })).toHaveCount(0);
  await expect(primary).toHaveAttribute("aria-pressed", "true");
  await expect(secondary).toHaveAttribute("aria-pressed", "true");
  await expect(files).toHaveAttribute("aria-selected", "true");

  await primary.click();
  await expect(primary).toHaveAttribute("aria-pressed", "false");
  await expect(conversations).toHaveCount(0);
  await expect(files).toHaveAttribute("aria-selected", "true");

  await secondary.click();
  await expect(secondary).toHaveAttribute("aria-pressed", "false");
  await expect(changes).toHaveCount(0);

  await secondary.click();
  await expect(secondary).toHaveAttribute("aria-pressed", "true");
  await expect(files).toHaveAttribute("aria-selected", "true");
  await changes.click();
  await secondary.click();
  await expect(changes).toHaveCount(0);
  await secondary.click();
  await expect(changes).toHaveAttribute("aria-selected", "true");
  await expect(primary).toHaveAttribute("aria-pressed", "false");

  await primary.click();
  await expect(conversations).toBeVisible();
  await expect(changes).toHaveAttribute("aria-selected", "true");

  await secondary.click();
  const heading = (await conversations.boundingBox())!;
  await page.mouse.click(heading.x + 10, heading.y + heading.height / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Move Primary Side Bar Right" }).click();
  await expect(secondary).toHaveAttribute("aria-pressed", "false");
  await expect(changes).toHaveCount(0);
  await secondary.click();
  await expect(changes).toHaveAttribute("aria-selected", "true");
  expect((await changes.boundingBox())!.x).toBeLessThan(
    (await page.getByRole("tab", { name: "Chat", exact: true }).boundingBox())!.x,
  );
});

test("manage opens an activity bar menu and hands focus to the chosen surface", async ({
  page,
}) => {
  await page.goto("/");
  const gear = page.getByRole("button", { name: "Manage", exact: true });
  const menu = page.getByRole("menu", { name: "Manage", exact: true });
  const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
  const settingsItem = menu.getByRole("menuitem", { name: "Settings", exact: true });

  await gear.click();
  await expect(menu).toBeVisible();
  await expect(settingsTab).toHaveCount(0);
  const menuBounds = (await menu.boundingBox())!;
  const gearBounds = (await gear.boundingBox())!;
  await expect(menu).toHaveAttribute("data-side", "right");
  expect(menuBounds.x).toBeCloseTo(gearBounds.x + gearBounds.width + 1, 0);
  expect(menuBounds.y + menuBounds.height).toBeCloseTo(gearBounds.y + gearBounds.height - 4, 0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(gear).toBeFocused();

  await gear.press("Enter");
  await expect(settingsItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Command Palette…", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "Search commands", exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(gear).toBeFocused();

  await gear.click();
  await settingsItem.click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const settingsSearch = settings.getByRole("searchbox", { name: "Search settings" });
  await expect(settingsSearch).toBeFocused();
  await expect(settingsTab).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(gear).toBeFocused();

  await page.keyboard.press("ControlOrMeta+,");
  await expect(settingsSearch).toBeFocused();
  await settings.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");

  await page.getByRole("combobox", { name: "Primary sidebar", exact: true }).click();
  await page.getByRole("option", { name: "Right", exact: true }).click();
  await expect.poll(async () => (await gear.boundingBox())?.x ?? 0).toBeGreaterThan(1000);
  await gear.click();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await expect(menu).toHaveAttribute("data-side", "left");
  const rightMenu = (await menu.boundingBox())!;
  const rightGear = (await gear.boundingBox())!;
  expect(rightMenu.x + rightMenu.width).toBeCloseTo(rightGear.x - 1, 0);
  expect(rightMenu.y + rightMenu.height).toBeCloseTo(rightGear.y + rightGear.height - 4, 0);
});

test("Files follow the selected workspace while a conversation stays open", async ({
  page,
}, testInfo) => {
  const frontendRoot = testInfo.outputPath("frontend");
  const releaseRoot = testInfo.outputPath("release");
  await Promise.all([
    mkdir(frontendRoot, { recursive: true }),
    mkdir(releaseRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(frontendRoot, "frontend-notes.txt"), "Frontend notes"),
    writeFile(join(releaseRoot, "release-checklist.txt"), "Release checklist"),
  ]);

  await page.goto("/");
  const conversations = page.getByRole("tree", { name: "Conversations", exact: true });
  const explorer = page.getByRole("tree", { name: "Explorer", exact: true });
  const frontendFile = explorer.getByRole("treeitem", { name: /^frontend-notes\.txt\b/ });
  const releaseFile = explorer.getByRole("treeitem", { name: /^release-checklist\.txt\b/ });
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const setup = await page.evaluate(
    async (roots) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createWorkspaces(roots),
    [frontendRoot, releaseRoot] as const,
  );

  try {
    const chatHeading = page
      .getByRole("region", { name: "Conversation", exact: true })
      .getByRole("heading", { name: "Frontend discussion", exact: true });
    await expect(chatHeading).toBeVisible();
    await expect(frontendFile).toBeVisible();
    await expect(releaseFile).toHaveCount(0);

    await conversations
      .getByRole("treeitem", { name: "Release fixture, has actions", exact: true })
      .click();
    await expect(releaseFile).toBeVisible();
    await expect(frontendFile).toHaveCount(0);
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(chatHeading).toBeVisible();
    await expect(frontendFile).toBeVisible();
    await expect(releaseFile).toHaveCount(0);

    await page.getByRole("tab", { name: "Release fixture", exact: true }).click();
    await expect(releaseFile).toBeVisible();
    await expect(frontendFile).toHaveCount(0);

    await conversations
      .getByRole("treeitem", { name: "Frontend fixture, has actions", exact: true })
      .click();
    await expect(frontendFile).toBeVisible();
    await expect(releaseFile).toHaveCount(0);
  } finally {
    await page.evaluate(async (ids) => {
      (await import("/tests/workbench-workspace.fixture.ts")).removeWorkspaces(ids);
    }, setup);
  }
});

test("opening the workspace panel keeps the conversation title size", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto("/");
  const conversation = page.getByRole("region", { name: "Conversation", exact: true });
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">New conversation");
  await page.keyboard.press("Enter");
  const title = conversation.getByRole("heading", { name: "New conversation", exact: true });
  const workspacePanel = page.getByRole("button", { name: "Toggle workspace panel", exact: true });
  const conversationWidth = () => conversation.evaluate((element) => element.clientWidth);

  await expect(workspacePanel).toHaveAttribute("aria-pressed", "true");
  await workspacePanel.click();
  await expect.poll(conversationWidth).toBeGreaterThan(480);
  await expect(title).toHaveCSS("font-size", "12px");

  await workspacePanel.click();
  await expect.poll(conversationWidth).toBeLessThanOrEqual(480);
  await expect(title).toHaveCSS("font-size", "12px");
});

test("compact workbench exposes the bottom panel and advertises the platform shortcut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });
  await page.goto("/");
  const palette = page.getByRole("button", { name: "Open command palette" });
  const primary = page.getByRole("button", { name: "Toggle primary sidebar" });
  const bottom = page.getByRole("button", { name: "Toggle bottom panel" });
  const terminal = page.getByRole("heading", { name: "Terminal", exact: true });

  await expect(palette).toHaveAttribute("aria-keyshortcuts", "Control+K");
  await expect(primary).toHaveAttribute("title", "Toggle primary sidebar (Ctrl+B)");
  await expect(bottom).toBeVisible();
  expect((await palette.boundingBox())!.x + (await palette.boundingBox())!.width).toBeLessThan(
    (await primary.boundingBox())!.x,
  );
  await expect(bottom).toHaveAttribute("aria-pressed", "false");
  await bottom.click();
  await expect(bottom).toHaveAttribute("aria-pressed", "true");
  await expect(terminal).toBeVisible();
  await page.keyboard.press("Control+Backquote");
  await expect(bottom).toHaveAttribute("aria-pressed", "false");
  await expect(terminal).toHaveCount(0);
});
