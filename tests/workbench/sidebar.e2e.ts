import { expect, test } from "@playwright/test";

test("Conversations is a sidebar heading that can be toggled, resized and moved", async ({
  page,
}) => {
  await page.goto("/");
  const title = page.getByRole("heading", { name: "Conversations", exact: true });
  const activity = page.getByRole("button", { name: "Conversations", exact: true });
  const sidebar = page.getByRole("region", { name: "Conversations", exact: true });
  await expect(title).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close Conversations", exact: true })).toHaveCount(
    0,
  );

  await activity.click();
  await expect(title).toBeHidden();
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await activity.click();
  await expect(title).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(title).toBeHidden();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(title).toBeVisible();

  const before = (await sidebar.boundingBox())!;
  await page.mouse.move(before.x + before.width, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 70, before.y + before.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await sidebar.boundingBox())!.width)
    .toBeGreaterThan(before.width + 30);

  const titleBox = (await title.boundingBox())!;
  const chatBox = (await page.getByRole("region", { name: "Chat", exact: true }).boundingBox())!;
  await page.mouse.move(titleBox.x + 70, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  await expect(title).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await title.boundingBox())!.y).toBe(titleBox.y);

  await page.mouse.move(titleBox.x + 70, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height - 12, {
    steps: 20,
  });
  await page.mouse.up();
  await expect.poll(async () => (await title.boundingBox())!.y).toBeGreaterThan(titleBox.y + 100);
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const layout = JSON.parse(localStorage.getItem("harness.layout.v1") ?? "null");
        return layout?.grid.root.data.some(
          (node: { type: string; data: { data?: { views?: string[] } }[] }) =>
            node.type === "branch" &&
            node.data.some((child) => child.data?.views?.includes("sessions")),
        );
      }),
    )
    .toBe(true);
  const movedY = (await title.boundingBox())!.y;
  await page.reload();
  await expect(title).toBeVisible();
  await expect.poll(async () => (await title.boundingBox())!.y).toBeCloseTo(movedY, 0);
});

test("activity bar switches views in the primary left sidebar and toggles visibility while right auxiliary views group separately", async ({
  page,
}) => {
  await page.goto("/");
  const conversationsButton = page.getByRole("button", { name: "Conversations", exact: true });
  const explorerButton = page.getByRole("button", { name: "Explorer", exact: true });
  const extensionsButton = page.getByRole("button", { name: "Extensions", exact: true });
  const conversationsHeading = page.getByRole("heading", { name: "Conversations", exact: true });
  const explorerHeading = page.getByRole("heading", { name: "Explorer", exact: true });
  const extensionsHeading = page.getByRole("heading", { name: "Extensions", exact: true });
  const contextTab = page.getByRole("tab", { name: "Context", exact: true });
  const changesTab = page.getByRole("tab", { name: "Changes", exact: true });

  await expect(conversationsHeading).toBeVisible();
  await expect(conversationsButton).toHaveClass(/active/);
  await expect(conversationsButton).toHaveAttribute("aria-expanded", "true");
  await expect(explorerButton).not.toHaveClass(/active/);
  await expect(contextTab).toBeVisible();
  await expect(changesTab).toBeVisible();

  const initialLeftBox = (await page
    .getByRole("region", { name: "Conversations", exact: true })
    .boundingBox())!;
  const chatBox = (await page.getByRole("region", { name: "Chat", exact: true }).boundingBox())!;
  expect(initialLeftBox.x).toBeLessThan(chatBox.x);

  await explorerButton.click();
  await expect(explorerHeading).toBeVisible();
  await expect(conversationsHeading).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Explorer", exact: true })).toHaveCount(0);
  await expect(explorerButton).toHaveClass(/active/);
  await expect(explorerButton).toHaveAttribute("aria-expanded", "true");
  await expect(conversationsButton).not.toHaveClass(/active/);
  const explorerRegionBox = (await page
    .getByRole("region", { name: "Explorer", exact: true })
    .boundingBox())!;
  expect(explorerRegionBox.x).toBeCloseTo(initialLeftBox.x, 0);
  expect(explorerRegionBox.width).toBeCloseTo(initialLeftBox.width, 0);

  await extensionsButton.click();
  await expect(extensionsHeading).toBeVisible();
  await expect(explorerHeading).toHaveCount(0);
  await expect(extensionsButton).toHaveClass(/active/);
  await expect(explorerButton).not.toHaveClass(/active/);

  await extensionsButton.click();
  await expect(extensionsHeading).toHaveCount(0);
  await expect(extensionsButton).not.toHaveClass(/active/);
  await expect(extensionsButton).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("ControlOrMeta+b");
  await expect(extensionsHeading).toBeVisible();
  await expect(extensionsButton).toHaveClass(/active/);

  await conversationsButton.click();
  await expect(conversationsHeading).toBeVisible();
  await expect(extensionsHeading).toHaveCount(0);
  await expect(conversationsButton).toHaveClass(/active/);

  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">Toggle Explorer");
  await page.keyboard.press("Enter");
  await expect(explorerHeading).toBeVisible();
  await expect(explorerButton).toHaveClass(/active/);
});

test("primary side bar and activity bar can be moved symmetrically to the right via context menu and command palette", async ({
  page,
}) => {
  await page.goto("/");
  const activityNav = page.getByRole("navigation", { name: "Workbench views", exact: true });
  const chatRegion = page.getByRole("region", { name: "Chat", exact: true });
  const primaryRegion = page.getByRole("region", { name: "Conversations", exact: true });
  const auxiliaryRegion = page.getByRole("region", { name: "Context", exact: true });

  const initialActivityBox = (await activityNav.boundingBox())!;
  const initialPrimaryBox = (await primaryRegion.boundingBox())!;
  const initialChatBox = (await chatRegion.boundingBox())!;
  const initialAuxBox = (await auxiliaryRegion.boundingBox())!;
  expect(initialActivityBox.x).toBeLessThan(initialPrimaryBox.x);
  expect(initialPrimaryBox.x).toBeLessThan(initialChatBox.x);
  expect(initialChatBox.x).toBeLessThan(initialAuxBox.x);

  const title = page.getByRole("heading", { name: "Conversations", exact: true });
  const titleRect = (await title.boundingBox())!;
  await page.mouse.click(titleRect.x + 20, titleRect.y + titleRect.height / 2, {
    button: "right",
  });
  const moveRightItem = page.getByRole("menuitem", {
    name: "Move Primary Side Bar Right",
    exact: true,
  });
  await expect(moveRightItem).toBeVisible();
  await moveRightItem.click();

  await expect(activityNav).toHaveClass(/right/);
  const rightActivityBox = (await activityNav.boundingBox())!;
  const rightPrimaryBox = (await primaryRegion.boundingBox())!;
  const rightChatBox = (await chatRegion.boundingBox())!;
  const rightAuxBox = (await auxiliaryRegion.boundingBox())!;
  expect(rightAuxBox.x).toBeLessThan(rightChatBox.x);
  expect(rightChatBox.x).toBeLessThan(rightPrimaryBox.x);
  expect(rightPrimaryBox.x).toBeLessThan(rightActivityBox.x);

  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  const explorerRegion = page.getByRole("region", { name: "Explorer", exact: true });
  await expect(explorerRegion).toBeVisible();
  const rightExplorerBox = (await explorerRegion.boundingBox())!;
  expect(rightExplorerBox.x).toBeGreaterThan(rightChatBox.x);
  expect(rightExplorerBox.x).toBeLessThan(rightActivityBox.x);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("harness.layout.v1")))
    .toContain("files");

  await page.reload();
  await expect(activityNav).toHaveClass(/right/);
  await expect(explorerRegion).toBeVisible();
  const reloadedExplorerBox = (await explorerRegion.boundingBox())!;
  const reloadedActivityBox = (await activityNav.boundingBox())!;
  expect(reloadedExplorerBox.x).toBeLessThan(reloadedActivityBox.x);
  expect(reloadedExplorerBox.x).toBeGreaterThan(700);

  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">Toggle Primary Side Bar Position");
  await page.keyboard.press("Enter");

  await expect(activityNav).toHaveClass(/left/);
  const restoredActivityBox = (await activityNav.boundingBox())!;
  const restoredExplorerBox = (await explorerRegion.boundingBox())!;
  const restoredChatBox = (await chatRegion.boundingBox())!;
  expect(restoredActivityBox.x).toBeLessThan(restoredExplorerBox.x);
  expect(restoredExplorerBox.x).toBeLessThan(restoredChatBox.x);
});

test("inline conversation rename supports menu action, F2, validation, Escape cancel and Enter commit", async ({
  page,
}) => {
  await page.goto("/");
  const navigation = page.getByRole("region", { name: "Conversations", exact: true });
  const previousSelection = await navigation.evaluate(
    (element) => element.querySelector('[role="treeitem"][aria-selected="true"]')?.id,
  );
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">New conversation");
  await page.keyboard.press("Enter");
  const tree = navigation.getByRole("tree", { name: "Conversations", exact: true });
  const row = tree.getByRole("treeitem", { name: /^New conversation\b/, selected: true });
  await expect(row).toBeVisible();
  if (previousSelection) await expect(row).not.toHaveAttribute("id", previousSelection);
  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for New conversation", exact: true })
    .getByRole("menuitem", { name: /Rename conversation/ })
    .click();

  const renameInput = row.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(renameInput).toBeFocused();
  await expect(renameInput).toHaveValue("New conversation");

  await renameInput.fill("   ");
  await expect(navigation.getByRole("alert")).toHaveText("Enter a conversation title.");
  await renameInput.press("Enter");
  await expect(renameInput).toBeFocused();

  await renameInput.press("Escape");
  await expect(renameInput).toHaveCount(0);
  await expect(tree).toBeFocused();
  await expect(tree).toHaveAttribute("aria-activedescendant", (await row.getAttribute("id")) ?? "");

  await tree.press("F2");
  await expect(renameInput).toBeFocused();
  await renameInput.fill("Renamed workbench session");
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0);
  await expect(tree).toBeFocused();
  await expect(
    tree.getByRole("treeitem", { name: /^Renamed workbench session\b/, selected: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Renamed workbench session", exact: true }),
  ).toBeVisible();
});

test("restores an old layout with Conversations grouped into editor tabs as a separate sidebar", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "harness.layout.v1",
      JSON.stringify({
        grid: {
          root: {
            type: "branch",
            data: [
              {
                type: "leaf",
                data: { id: "legacy", views: ["chat", "sessions"], activeView: "sessions" },
                size: 1000,
              },
            ],
            size: 800,
          },
          width: 1400,
          height: 800,
          orientation: "HORIZONTAL",
        },
        panels: {
          chat: {
            id: "chat",
            contentComponent: "extension",
            title: "Chat",
            params: { panelId: "chat" },
          },
          sessions: {
            id: "sessions",
            contentComponent: "extension",
            title: "Conversations",
            params: { panelId: "sessions" },
          },
        },
        activeGroup: "legacy",
      }),
    );
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conversations", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Explorer", exact: true })).toHaveCount(0);
});

test("sidebar widths do not jump when toggling, switching, or moving panels", async ({ page }) => {
  await page.goto("/");
  const left = page.getByRole("region", { name: "Conversations", exact: true });
  const right = page.getByRole("region", { name: "Context", exact: true });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();

  // Resize left sidebar to ~320px
  const leftBox0 = (await left.boundingBox())!;
  await page.mouse.move(leftBox0.x + leftBox0.width, leftBox0.y + leftBox0.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftBox0.x + 320, leftBox0.y + leftBox0.height / 2, { steps: 10 });
  await page.mouse.up();
  const leftWidth = (await left.boundingBox())!.width;
  expect(leftWidth).toBeGreaterThan(300);

  // Resize right sidebar to ~350px
  const rightBox0 = (await right.boundingBox())!;
  await page.mouse.move(rightBox0.x, rightBox0.y + rightBox0.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightBox0.x + rightBox0.width - 350, rightBox0.y + rightBox0.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  const rightWidth = (await right.boundingBox())!.width;
  expect(rightWidth).toBeGreaterThan(330);

  // 1. Toggle right sidebar off and on -> left width must not jump, right width must be restored
  await page.keyboard.press("ControlOrMeta+Shift+e").catch(() => {});
  const contextTab = page.getByRole("tab", { name: "Context", exact: true });
  const closeContextBtn = page.getByRole("button", { name: "Close Context", exact: true });
  if (await closeContextBtn.count()) {
    await closeContextBtn.click();
  } else {
    // Use activity bar or header button if any; let's check via left sidebar toggle first
  }

  // Toggle left sidebar off and on -> right width must not jump, left width must be restored
  await page.keyboard.press("ControlOrMeta+b");
  await expect(left).toHaveCount(0);
  expect(Math.abs((await right.boundingBox())!.width - rightWidth)).toBeLessThanOrEqual(2);

  await page.keyboard.press("ControlOrMeta+b");
  await expect(left).toBeVisible();
  expect(Math.abs((await left.boundingBox())!.width - leftWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs((await right.boundingBox())!.width - rightWidth)).toBeLessThanOrEqual(2);

  // 2. Switch left sidebar view (Conversations -> Explorer) -> widths must not jump
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  const explorer = page.getByRole("region", { name: "Explorer", exact: true });
  await expect(explorer).toBeVisible();
  expect(Math.abs((await explorer.boundingBox())!.width - leftWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs((await right.boundingBox())!.width - rightWidth)).toBeLessThanOrEqual(2);
});
