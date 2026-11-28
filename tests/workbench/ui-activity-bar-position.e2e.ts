import { expect, test, type Page } from "@playwright/test";

const positionLabels = ["Default", "Top", "Bottom", "Hidden"] as const;
type PositionLabel = (typeof positionLabels)[number];

function activityBar(page: Page) {
  return page.getByRole("navigation", { name: "Workbench views", exact: true });
}

function sidebarHeading(page: Page) {
  return page.getByRole("heading", { name: "Conversations", exact: true });
}

async function openSidebarMenu(page: Page) {
  await expect(sidebarHeading(page)).toBeVisible();
  const title = (await sidebarHeading(page).boundingBox())!;
  await page.mouse.click(title.x + 10, title.y + title.height / 2, { button: "right" });
}

async function openPositionMenu(page: Page) {
  await openSidebarMenu(page);
  const item = page.getByRole("menuitem", { name: "Activity Bar Position", exact: true });
  await item.hover();
  await expect(page.getByRole("menuitemradio", { name: "Default", exact: true })).toBeVisible();
}

async function choosePosition(page: Page, position: PositionLabel) {
  await openPositionMenu(page);
  await page.getByRole("menuitemradio", { name: position, exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Primary Side Bar actions", exact: true }),
  ).toBeHidden();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

test("activity bar position submenu supports keyboard selection and cancellation", async ({
  page,
}) => {
  await page.goto("/");
  const conversations = page.getByRole("button", { name: "Conversations", exact: true });
  await conversations.focus();
  await conversations.press("Shift+F10");
  const position = page.getByRole("menuitem", { name: "Activity Bar Position", exact: true });
  await expect(position).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveText([...positionLabels]);
  const defaultOption = page.getByRole("menuitemradio", { name: "Default", exact: true });
  const top = page.getByRole("menuitemradio", { name: "Top", exact: true });
  await expect(defaultOption).toBeFocused();
  await expect(defaultOption).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(top).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(position).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(conversations).toBeFocused();
  await expect(activityBar(page)).not.toHaveClass(/horizontal/);

  await conversations.press("Shift+F10");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(activityBar(page)).toHaveClass(/horizontal/);
  await expect(activityBar(page)).toHaveClass(/top/);
  await expect(conversations).toBeFocused();
  await openPositionMenu(page);
  await expect(top).toHaveAttribute("aria-checked", "true");
  await expect(defaultOption).toHaveAttribute("aria-checked", "false");
});

for (const position of ["Top", "Bottom"] as const) {
  test(`${position} activity indicator points toward the sidebar content on either side`, async ({
    page,
  }) => {
    await page.goto("/");
    await choosePosition(page, position);
    const button = activityBar(page).getByRole("button", { name: "Conversations", exact: true });
    const indicator = () =>
      button.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const icon = element.querySelector("span")!.getBoundingClientRect();
        const line = getComputedStyle(element, "::before");
        const x = button.x + parseFloat(line.left);
        const y = button.y + parseFloat(line.top);
        const width = parseFloat(line.width);
        const height = parseFloat(line.height);
        return {
          belowIcon: y >= icon.bottom,
          aboveIcon: y + height <= icon.top,
          insideButton:
            x > button.x && x + width < button.right && y > button.y && y + height < button.bottom,
          centered: Math.abs(x + width / 2 - (icon.x + icon.width / 2)) < 0.5,
          height,
        };
      });
    for (const side of ["left", "right"] as const) {
      if (side === "right") {
        await openSidebarMenu(page);
        await page
          .getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true })
          .click();
      }
      await page.getByRole("button", { name: "Toggle primary sidebar", exact: true }).focus();
      await expect.poll(indicator).toEqual({
        belowIcon: position === "Top",
        aboveIcon: position === "Bottom",
        insideButton: true,
        centered: true,
        height: 1,
      });
      await page.keyboard.press("Tab");
      await button.focus();
      await expect.poll(async () => (await indicator()).height).toBe(2);
      await expect.poll(async () => (await indicator()).insideButton).toBe(true);
    }
  });

  test(`choosing ${position} while the primary sidebar is hidden preserves visibility and restores focus`, async ({
    page,
  }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
    await expect(sidebarHeading(page)).toBeVisible();
    await toggle.click();
    await expect(sidebarHeading(page)).toBeHidden();
    const conversations = page.getByRole("button", { name: "Conversations", exact: true });
    await conversations.focus();
    await conversations.press("Shift+F10");
    await expect(
      page.getByRole("menuitem", { name: "Activity Bar Position", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    if (position === "Bottom") await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: position, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(sidebarHeading(page)).toBeHidden();
    await expect(activityBar(page)).toBeHidden();
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Manage", exact: true }),
    ).toBeFocused();

    await toggle.click();
    await expect(sidebarHeading(page)).toBeVisible();
    await expect(activityBar(page)).toBeVisible();
    await expect(activityBar(page)).toHaveClass(/horizontal/);
    await expect(activityBar(page)).toHaveClass(new RegExp(position.toLowerCase()));
  });

  test(`${position} activity bar stays inside the primary sidebar when moved or toggled`, async ({
    page,
  }) => {
    await page.goto("/");
    const sidebar = page.getByRole("region", { name: "Conversations", exact: true });
    await expect(sidebar).toBeVisible();
    const initialWidth = (await sidebar.boundingBox())!.width;
    await choosePosition(page, position);
    const bar = activityBar(page);
    const group = page.locator(".dv-groupview").filter({ has: sidebarHeading(page) });
    await expect(bar).toHaveClass(/horizontal/);
    await expect(bar).toHaveClass(new RegExp(position.toLowerCase()));
    await expect.poll(async () => (await bar.boundingBox())!.height).toBe(35);
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeCloseTo(initialWidth, 0);
    await expect
      .poll(async () => {
        const bounds = (await bar.boundingBox())!;
        const parent = (await group.boundingBox())!;
        const heading = (await sidebarHeading(page).boundingBox())!;
        return (
          bounds.x >= parent.x &&
          bounds.x + bounds.width <= parent.x + parent.width + 1 &&
          (position === "Top"
            ? bounds.y + bounds.height <= heading.y
            : Math.abs(bounds.y + bounds.height - parent.y - parent.height) <= 1)
        );
      })
      .toBe(true);
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Manage", exact: true }),
    ).toBeVisible();
    await bar.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect(sidebarHeading(page)).toBeVisible();

    await openSidebarMenu(page);
    await page.getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true }).click();
    await expect
      .poll(async () => {
        const activity = (await bar.boundingBox())!;
        const chat = (await page.getByRole("region", { name: "Chat", exact: true }).boundingBox())!;
        return activity.x >= chat.x + chat.width;
      })
      .toBe(true);
    const toggle = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
    await toggle.click();
    await expect(bar).toBeHidden();
    await expect(sidebarHeading(page)).toBeHidden();
    await toggle.click();
    await expect(bar).toBeVisible();
    await expect(sidebarHeading(page)).toBeVisible();
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeCloseTo(initialWidth, 0);
  });
}

test("hidden activity bar keeps the sidebar and can be restored from its header or Settings", async ({
  page,
}) => {
  await page.goto("/");
  await choosePosition(page, "Hidden");
  await expect(activityBar(page)).toBeHidden();
  await expect(sidebarHeading(page)).toBeVisible();
  await expect(
    page.locator(".titlebar").getByRole("button", { name: "Manage", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage", exact: true })).toBeFocused();
  await openPositionMenu(page);
  await expect(page.getByRole("menuitemradio", { name: "Hidden", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  await expect(activityBar(page)).toBeVisible();
  await expect(activityBar(page)).not.toHaveClass(/horizontal/);
  await expect(
    activityBar(page).getByRole("button", { name: "Manage", exact: true }),
  ).toBeVisible();

  await choosePosition(page, "Hidden");
  const settings = await openSettings(page);
  await settings.getByRole("searchbox", { name: "Search settings" }).fill("activity bar position");
  await expect(settings.getByRole("status")).toHaveText("1 setting");
  const choice = settings.getByRole("combobox", { name: "Activity Bar Position", exact: true });
  await expect(choice).toHaveText("Hidden");
  await choice.click();
  await page.getByRole("option", { name: "Top", exact: true }).click();
  await settings.getByRole("button", { name: "Close Settings", exact: true }).click();
  await expect(activityBar(page)).toHaveClass(/top/);
  await expect(sidebarHeading(page)).toBeVisible();

  await openSettings(page);
  await expect(choice).toHaveText("Top");
  await choice.click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(page.locator(".titlebar .manage-button")).toHaveCount(0);
  await settings.getByRole("button", { name: "Close Settings", exact: true }).click();
  await expect(activityBar(page)).toBeVisible();
  await expect(activityBar(page)).not.toHaveClass(/horizontal/);
  await expect(
    activityBar(page).getByRole("button", { name: "Manage", exact: true }),
  ).toBeFocused();
});

test("activity bar position persists on reload and follows changes in another window", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(sidebarHeading(page)).toBeVisible();
  const peer = await context.newPage();
  await peer.goto("/");
  await expect(activityBar(peer)).toBeVisible();
  await choosePosition(page, "Bottom");
  await expect(activityBar(peer)).toHaveClass(/bottom/);
  await page.reload();
  await expect(activityBar(page)).toHaveClass(/bottom/);
  await openPositionMenu(page);
  await expect(page.getByRole("menuitemradio", { name: "Bottom", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await choosePosition(peer, "Hidden");
  await expect(activityBar(page)).toBeHidden();
  await page.reload();
  await expect(sidebarHeading(page)).toBeVisible();
  await expect(activityBar(page)).toBeHidden();
  await choosePosition(page, "Default");
  await expect(activityBar(peer)).toBeVisible();
  await expect(activityBar(peer)).not.toHaveClass(/horizontal/);
  await peer.close();
});

test("activity bar position submenu remains usable in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await openPositionMenu(page);
  for (const label of positionLabels) {
    await expect(page.getByRole("menuitemradio", { name: label, exact: true })).toBeInViewport({
      ratio: 1,
    });
  }
  await page.getByRole("menuitemradio", { name: "Top", exact: true }).click();
  await expect(activityBar(page)).toBeInViewport({ ratio: 1 });
  await openPositionMenu(page);
  await page.getByRole("menuitemradio", { name: "Bottom", exact: true }).click();
  await expect(activityBar(page)).toBeInViewport({ ratio: 1 });
});
