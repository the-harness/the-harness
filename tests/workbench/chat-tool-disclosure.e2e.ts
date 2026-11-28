import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/chat-tools-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><div id="app"></div>',
  }));
  await page.goto("/chat-tools-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).mountTools(),
  );
});

test("keyboard activation opens the file without toggling its tool disclosure", async ({ page }) => {
  const header = page.locator(".tl-head").first();
  const file = header.getByRole("button", { name: "example.ts", exact: true });
  await file.press("Enter");
  await expect(page.getByLabel("Opened files")).toHaveText("1");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await file.press("Space");
  await expect(page.getByLabel("Opened files")).toHaveText("2");
  await expect(header).toHaveAttribute("aria-expanded", "false");

  await header.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Copy file content" }).first()).toBeVisible();
  await header.press("Space");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(header.locator(".tl-car-ic")).toHaveCSS("opacity", "1");
});

test("long search details keep narrow tool rows on one line", async ({ page }) => {
  const header = page.locator(".tl-head").nth(1);
  const detail = header.locator(".tl-dim");
  await expect(detail).toHaveAttribute("title", /nested-source-directory/);
  await expect.poll(() => header.evaluate((el) => el.getBoundingClientRect().height)).toBe(22);
  await expect.poll(() => detail.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await header.click();
  await expect(page.getByText("Found one match", { exact: true })).toBeVisible();
});
