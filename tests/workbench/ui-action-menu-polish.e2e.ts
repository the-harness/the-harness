import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui-action-menu-polish.fixture.html");
});

test("action menus announce selection, skip disabled actions and restore keyboard focus", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "Model actions" });
  const menu = page.getByRole("menu", { name: "Model actions" });
  await trigger.press("Enter");
  await expect(menu.getByRole("menuitemradio", { name: "Standard", exact: true })).toBeChecked();
  await page.keyboard.press("ArrowDown");
  const review = menu.getByRole("menuitemradio", { name: "Review", exact: true });
  await expect(review).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Review");
  await trigger.press("Enter");
  await expect(review).toBeChecked();
  await expect(
    menu.getByRole("menuitemradio", { name: "Standard", exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByLabel("Last action")).toBeEmpty();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "Open details" }).click();
  await expect(page.getByRole("textbox", { name: "Details" })).toBeFocused();
});

test("action menus keep mixed indicators aligned and long labels inside a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.getByRole("button", { name: "Model actions" }).click();
  const menu = page.getByRole("menu", { name: "Model actions" });
  await expect(menu).toBeInViewport({ ratio: 1 });
  const labels = await menu.locator(".menu-item-label").evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        scroll: element.scrollWidth,
        width: element.clientWidth,
        overflow: getComputedStyle(element).textOverflow,
        whiteSpace: getComputedStyle(element).whiteSpace,
      };
    }),
  );
  expect(new Set(labels.map((label) => label.left)).size).toBe(1);
  for (const label of labels) {
    expect(label.right).toBeLessThanOrEqual(312);
    expect(label.overflow).toBe("ellipsis");
    expect(label.whiteSpace).toBe("nowrap");
  }
  await page.getByRole("menuitem", { name: /DocumentationAndRelease/ }).click();
  await expect(page.getByLabel("Last action")).toContainText("DocumentationAndRelease");
});

test("disabled buttons keep their appearance on hover and menus respect reduced motion", async ({
  page,
}) => {
  for (const label of ["Disabled primary", "Disabled secondary", "Disabled action"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    const before = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.filter];
    });
    await button.hover();
    expect(
      await button.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.color, style.filter];
      }),
    ).toEqual(before);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Model actions" }).click();
  const menu = page.getByRole("menu", { name: "Model actions" });
  await expect(menu).toHaveCSS("animation-iteration-count", "1");
  expect(
    await menu.evaluate((element) => parseFloat(getComputedStyle(element).animationDuration)),
  ).toBeLessThan(0.001);
});

test("action menus leave IME confirmation and navigation to the input method", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Model actions" });
  await trigger.press("Enter");
  const menu = page.getByRole("menu", { name: "Model actions" });
  const standard = menu.getByRole("menuitemradio", { name: "Standard", exact: true });
  await expect(standard).toBeFocused();
  for (const key of ["ArrowDown", "ArrowUp", "Enter", " ", "r", "Escape"]) {
    await standard.dispatchEvent("keydown", { key, isComposing: true });
    await expect(menu).toBeVisible();
    await expect(standard).toBeFocused();
  }
  await standard.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(menu).toBeVisible();
  await standard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Review");
});

test("action menu navigation wraps around disabled entries and closes on window changes", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Model actions" });
  const menu = page.getByRole("menu", { name: "Model actions" });
  await trigger.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Open details" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Standard", exact: true })).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(menu).toBeHidden();
  await trigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 720, height: 500 });
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("menus opened in dialogs remain above their overlay and return focus to the dialog", async ({ page }) => {
  await page.getByRole("button", { name: "Open menu dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu dialog" });
  const trigger = dialog.getByRole("button", { name: "Dialog actions" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Run in dialog" }).click();
  await expect(page.getByLabel("Last action")).toHaveText("Dialog action ran");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
});

test("pointer context menus take focus so arrow navigation stays in the menu", async ({ page }) => {
  await page.goto("/tests/menu-foundation.fixture.html");
  const trigger = page.getByRole("button", { name: "README.md — right-click here" });
  await trigger.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Item actions", exact: true });
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Open README.md" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("keyboard context menus anchor below wide rows and keep submenus in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.goto("/tests/menu-foundation.fixture.html");
  const trigger = page.getByRole("button", { name: "README.md — right-click here" });
  await trigger.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Item actions", exact: true });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("menuitem", { name: "Open README.md" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  const submenu = page.getByRole("menu", { name: "Side Bar Position", exact: true });
  await expect(submenu).toBeInViewport({ ratio: 1 });
  await expect(submenu.getByRole("menuitemradio", { name: "Left", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(submenu).toBeHidden();
  await expect(menu.getByRole("menuitem", { name: "Side Bar Position" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("background context menus restore the previously focused input", async ({ page }) => {
  await page.goto("/tests/menu-foundation.fixture.html");
  const input = page.getByRole("textbox", { name: "Outside field" });
  await input.fill("Keep editing");
  await page.getByText("Pane background", { exact: true }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Background actions", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
});

test("keyboard context menus return focus to a control inside the trigger", async ({ page }) => {
  await page.goto("/tests/menu-foundation.fixture.html");
  const button = page.getByRole("button", { name: "Nested control" });
  await button.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Nested actions", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});


test("third-party menu hooks can remove and replace built-in output actions and unload cleanly", async ({ page }) => {
  await page.goto("/tests/menu-foundation.fixture.html");
  const trigger = page.getByRole("button", { name: "Output actions", exact: true });
  const menu = page.getByRole("menu", { name: "Output actions", exact: true });
  await trigger.click();
  await expect(menu.getByRole("menuitem", { name: "Clear Output", exact: true })).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Load output extension", exact: true }).click();
  await trigger.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "Clear Output", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Copy All", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("separator")).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Inspect Output", exact: true }).click();
  await expect(page.getByLabel("Action result", { exact: true })).toHaveText("Inspected output");
  await expect(trigger).toBeFocused();

  await page.getByRole("button", { name: "Unload output extension", exact: true }).click();
  await trigger.click();
  await expect(menu.getByRole("menuitem", { name: "Clear Output", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy All", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Inspect Output", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("separator")).toHaveCount(1);
});
