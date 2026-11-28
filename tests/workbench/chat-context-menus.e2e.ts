import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/chat-menu-fixture", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><div id="app"></div>',
  }));
  await page.goto("/chat-menu-fixture");
  await page.evaluate(async () => (await import("/tests/chat-detail-polish.fixture.ts")).mountMenuChat());
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  await expect(page.locator(".chat-row")).toHaveCount(2);
});

test("message menus copy the targeted code or message and reuse prompts into the composer", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "Message Harness" });
  await input.focus();
  await page.locator(".chat-row.user").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await menu.getByRole("menuitem", { name: "Copy Message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Inspect the menu target.");
  await expect(input).toBeFocused();

  await page.locator(".md-code-pre").click({ button: "right" });
  await page.getByRole("menu", { name: "Code actions", exact: true }).getByRole("menuitem", { name: "Copy Code", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("const target = 'reply';");
  await page.getByRole("link", { name: "Reference" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy Link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("https://example.com/reference");

  const user = page.locator(".chat-row.user");
  await user.focus();
  await user.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Reuse Prompt", exact: true }).click();
  await expect(input).toHaveValue("Inspect the menu target.");
  await expect(input).toBeFocused();
  await input.click({ button: "right" });
  await expect(menu).toBeHidden();
});

test("switching conversations invalidates an open message menu", async ({ page }) => {
  await page.locator(".chat-row.user").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await expect(menu).toBeVisible();
  await page.evaluate(async () => (await import("/tests/chat-detail-polish.fixture.ts")).switchMenuConversation());
  await expect(menu).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toHaveValue("");
});
