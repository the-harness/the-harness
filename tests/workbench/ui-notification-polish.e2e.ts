import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, platform: string) {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, "platform", { get: () => value });
  }, platform);
  await page.route("**/notification-polish-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/notification-polish-fixture");
  await page.evaluate(() => import("/tests/ui-notification-polish.fixture.ts"));
}

async function show(page: Page, actions: string[], cancelAction?: number) {
  await page.evaluate(
    async ({ actions, cancelAction }) => {
      (await import("/tests/ui-notification-polish.fixture.ts")).show(actions, cancelAction);
    },
    { actions, cancelAction },
  );
  return page.getByRole("alertdialog", { name: "Save changes?", exact: true });
}

function result(page: Page) {
  return page.evaluate(() =>
    import("/tests/ui-notification-polish.fixture.ts").then((fixture) => fixture.result()),
  );
}

test("notification menus copy and dismiss their target without choosing an action", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page, "MacIntel");
  await page.evaluate(async () => (await import("/tests/ui-notification-polish.fixture.ts")).showNotifications());
  const prompt = page.locator(".ui-notification-toast").filter({ hasText: "A file changed" });
  const toast = page.locator(".ui-notification-toast").filter({ hasText: "Workspace refreshed" });
  const close = prompt.getByRole("button", { name: "Dismiss notification" });
  await close.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Notification actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Copy Message", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(close).toBeFocused();
  await prompt.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy Message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("A file changed\n\nReview the updated file.");
  await prompt.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Dismiss Notification", exact: true }).click();
  await expect(prompt).toBeHidden();
  expect(await result(page)).toBeUndefined();
  await expect(toast).toBeVisible();
  await toast.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.evaluate(async () => (await import("/tests/ui-notification-polish.fixture.ts")).clearNotifications());
  await expect(menu).toBeHidden();
});

for (const platform of ["Win32", "MacIntel", "Linux x86_64"]) {
  test(`confirmation buttons follow platform order and preserve action indices on ${platform}`, async ({
    page,
  }) => {
    await mount(page, platform);
    const actions = ["Save", "Keep editing", "Discard"];
    const expected =
      platform === "Win32"
        ? ["Save", "Discard", "Keep editing"]
        : ["Discard", "Keep editing", "Save"];
    const dialog = await show(page, actions, 1);
    await expect(dialog.getByRole("button")).toHaveText(expected);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveClass(
      "primary-button",
    );
    await expect(dialog.getByRole("button", { name: "Discard", exact: true })).toHaveClass(
      "secondary-button",
    );
    await expect(dialog.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
    await dialog.getByRole("button").first().focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button").nth(1)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button").nth(2)).toBeFocused();
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
    expect(await result(page)).toBe(2);

    await show(page, actions, 1);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(await result(page)).toBe(0);
    await show(page, actions, 1);
    await expect(dialog.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    expect(await result(page)).toBe(1);
  });
}

test("confirmation defaults remain usable and centered within a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await mount(page, "MacIntel");
  const dialog = await show(page, ["Save"]);
  await expect(dialog).toHaveCSS("position", "fixed");
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(16);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(374);
  expect(bounds.y).toBeGreaterThanOrEqual(16);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(464);
  expect(bounds.x + bounds.width / 2).toBeCloseTo(195, 0);
  expect(bounds.y + bounds.height / 2).toBeCloseTo(240, 0);
  await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Save"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await result(page)).toBeUndefined();

  await show(page, []);
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  await expect(ok).toHaveClass("primary-button");
  await expect(ok).toBeFocused();
  await ok.click();
  expect(await result(page)).toBeUndefined();

  await show(page, ["Cancel", "Save"], 0);
  await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Save"]);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveClass(
    "primary-button",
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(await result(page)).toBe(1);
});
