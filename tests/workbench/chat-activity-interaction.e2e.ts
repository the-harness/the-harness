import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/chat-activity-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><div id="app"></div>',
  }));
  await page.goto("/chat-activity-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).mountTools(),
  );
});

test("completed activity still collapses automatically when untouched", async ({ page }) => {
  await expect(page.locator(".ar-head")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".think-head")).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishActivity(),
  );
  await expect(page.locator(".ar-head")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".think-head")).toHaveAttribute("aria-expanded", "false");
});

test("finishing preserves tool output and thoughts opened by the reader", async ({ page }) => {
  await page.getByRole("button", { name: "Read active.ts", exact: true }).click();
  const thought = page.locator(".think-head");
  await thought.press("Space");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishActivity(),
  );
  await expect(page.locator(".ar-head")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Active output", { exact: true })).toBeVisible();
  await expect(thought).toHaveAttribute("aria-expanded", "true");
  await expect(thought).toBeFocused();
});

test("finishing respects activity manually collapsed by the reader", async ({ page }) => {
  await page.locator(".ar-head").click();
  await page.locator(".think-head").click();
  await page.locator(".think-head").click();
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishActivity(),
  );
  await expect(page.locator(".ar-head")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".think-head")).toHaveAttribute("aria-expanded", "false");
});

test("thinking keeps its icon while disclosure arrows appear only on hover or keyboard focus", async ({ page }) => {
  const thought = page.locator(".think-head");
  await expect(thought.locator(".i-codicon-lightbulb")).toBeVisible();

  for (const selector of [".think-head", ".ar-head"]) {
    const header = page.locator(selector);
    const arrow = header.locator(".think-car, .ar-car");
    await page.mouse.move(0, 0);
    await expect(arrow).toHaveCSS("opacity", "0");
    const width = await header.evaluate((el) => el.getBoundingClientRect().width);
    await header.hover();
    await expect(arrow).toHaveCSS("opacity", "1");
    await expect.poll(() => header.evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
    await page.mouse.move(0, 0);
    await expect(arrow).toHaveCSS("opacity", "0");
    await header.press("Space");
    await expect(arrow).toHaveCSS("opacity", "1");
    await header.press("Tab");
    await expect(arrow).toHaveCSS("opacity", "0");
  }

  await expect(thought.locator(".i-codicon-lightbulb")).toBeVisible();
  await thought.press("Space");
  await expect(thought.locator(".i-codicon-lightbulb")).toBeVisible();
  await expect(page.locator(".ar-head .think-ic")).toHaveCount(0);
});
