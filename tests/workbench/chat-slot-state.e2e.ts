import { expect, test } from "@playwright/test";

test("updating a contributed chat block preserves its local state and keyboard focus", async ({ page }) => {
  await page.route("**/chat-slot-state-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><div id="app"></div>',
  }));
  await page.goto("/chat-slot-state-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).mountChat(),
  );
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).populateChat(true),
  );
  const thought = page.locator(".think-head");
  await thought.press("Space");
  const expanded = await thought.getAttribute("aria-expanded");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  await expect(thought).toHaveAttribute("aria-expanded", expanded!);
  await expect(thought).toBeFocused();
});
