import { expect, test } from "@playwright/test";

test("SCM context actions retain the provider and group target", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).install());
  const providers = page.locator(".scm-provider");
  const second = providers.filter({ hasText: "Second Repository" });
  const file = second.getByRole("button", { name: "file.txt", exact: true });
  await file.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Source Control actions", exact: true });
  await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).calls())).toEqual(["Second"]);
  await expect(file).toBeFocused();
  const group = second.locator(".scm-group-title");
  await group.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Collapse", exact: true }).click();
  await expect(file).toBeHidden();
  await expect(providers.first().getByRole("button", { name: "file.txt", exact: true })).toBeVisible();
  await group.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Expand", exact: true }).click();
  await file.press("Shift+F10");
  await page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).removeSecond());
  await expect(menu).toBeHidden();
});


test("replacing an SCM provider invalidates its menu even when an extension bypasses next", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await page.evaluate(async () => {
    const fixture = await import("/tests/scm-context-menus.fixture.ts");
    fixture.install();
    fixture.overrideResourceMenu();
  });
  const file = page.locator(".scm-provider").filter({ hasText: "Second Repository" })
    .getByRole("button", { name: "file.txt", exact: true });
  await file.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Source Control actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Extension Action", exact: true })).toBeVisible();
  await page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).replaceSecond());
  await expect(menu).toBeHidden();
  await expect.poll(() => page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).calls())).toEqual([]);
  await file.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Extension Action", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await import("/tests/scm-context-menus.fixture.ts")).calls())).toEqual(["Override"]);
});
