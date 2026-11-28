import { expect, test } from "@playwright/test";

test("sidebar context menu supports keyboard navigation and returns focus on Escape", async ({
  page,
}) => {
  await page.goto("/");
  const conversations = page.getByRole("button", { name: "Conversations", exact: true });
  const menu = page.getByRole("menu", { name: "Primary Side Bar actions", exact: true });
  await conversations.focus();
  await conversations.press("Shift+F10");
  await expect(menu).toBeVisible();
  const position = menu.getByRole("menuitem", { name: "Activity Bar Position", exact: true });
  const move = menu.getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true });
  const hide = menu.getByRole("menuitem", { name: /Hide primary sidebar/ });
  await expect(position).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(move).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(hide).toBeFocused();
  await page.keyboard.press("Home");
  await expect(position).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(conversations).toBeFocused();

  await conversations.click({ button: "right" });
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(position).toBeFocused();
  await page.keyboard.press("End");
  await expect(hide).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(conversations).toHaveAttribute("aria-expanded", "false");
});

test("layout controls follow their screen positions and show hidden regions in their icons", async ({
  page,
}) => {
  await page.goto("/");
  const controls = page.getByRole("group", { name: "Layout controls", exact: true });
  const primary = controls.getByRole("button", { name: "Toggle primary sidebar", exact: true });
  const secondary = controls.getByRole("button", { name: "Toggle workspace panel", exact: true });
  const bottom = controls.getByRole("button", { name: "Toggle bottom panel", exact: true });
  const buttonOrder = () =>
    controls
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  await expect
    .poll(buttonOrder)
    .toEqual(["Toggle primary sidebar", "Toggle bottom panel", "Toggle workspace panel"]);
  await primary.click();
  await expect(primary).toHaveAttribute("aria-pressed", "false");
  await expect(primary.locator("span")).toHaveClass("i-codicon-layout-sidebar-left-off");
  await expect(primary.locator("span")).not.toHaveCSS("mask-image", "none");
  await primary.click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true }).click();
  await expect
    .poll(buttonOrder)
    .toEqual(["Toggle workspace panel", "Toggle bottom panel", "Toggle primary sidebar"]);
  expect((await secondary.boundingBox())!.x).toBeLessThan((await bottom.boundingBox())!.x);
  expect((await bottom.boundingBox())!.x).toBeLessThan((await primary.boundingBox())!.x);
  await secondary.focus();
  await page.keyboard.press("Tab");
  await expect(bottom).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await primary.click();
  await expect(primary.locator("span")).toHaveClass("i-codicon-layout-sidebar-right-off");
  await secondary.click();
  await expect(secondary.locator("span")).toHaveClass("i-codicon-layout-sidebar-left-off");
  await expect(bottom.locator("span")).toHaveClass("i-codicon-layout-panel-off");
});

test("sidebar context menu stays within a narrow viewport and dismisses on outside interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  await manage.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Primary Side Bar actions", exact: true });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true }).click();
  await manage.click({ button: "right" });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Search commands", exact: true })).toBeFocused();
});
