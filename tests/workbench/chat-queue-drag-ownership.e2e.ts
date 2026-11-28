import { expect, test, type Page } from "@playwright/test";

async function dragFirstBelowSecond(page: Page) {
  await page
    .locator(".pending-grip")
    .first()
    .evaluate((grip) => {
      const source = grip.closest(".pending-item")!.getBoundingClientRect();
      const target = grip.closest(".pending-queue-list")!.lastElementChild!.getBoundingClientRect();
      grip.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: source.left + 1,
          clientY: source.top + source.height / 2,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          clientX: source.left + 1,
          clientY: target.bottom + 2,
        }),
      );
    });
  await expect(page.locator(".pending-queue-list")).toHaveClass(/is-dragging/);
}

async function endDrag(page: Page, type: "pointercancel" | "pointerup") {
  await page.evaluate((type) => {
    window.dispatchEvent(new PointerEvent(type, { pointerId: 1 }));
  }, type);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/chat-queue-drag-ownership-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/chat-queue-drag-ownership-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-queue-drag-ownership.fixture.ts")).mountChat(),
  );
  await expect(page.locator(".pending-text")).toHaveText(["First prompt 1", "First prompt 2"]);
});

test("only a completed queue drag changes message order", async ({ page }) => {
  const messages = page.locator(".pending-text");
  await dragFirstBelowSecond(page);
  await endDrag(page, "pointercancel");
  await expect(messages).toHaveText(["First prompt 1", "First prompt 2"]);
  await expect(page.locator(".pending-queue-list")).not.toHaveClass(/is-dragging/);

  await dragFirstBelowSecond(page);
  await endDrag(page, "pointerup");
  await expect(messages).toHaveText(["First prompt 2", "First prompt 1"]);
});

test("switching conversations cancels a queue drag even when their message IDs match", async ({
  page,
}) => {
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import("/tests/chat-queue-drag-ownership.fixture.ts")).secondQueueReady(),
      ),
    )
    .toBe(true);
  await dragFirstBelowSecond(page);
  await page.evaluate(async () =>
    (await import("/tests/chat-queue-drag-ownership.fixture.ts")).selectSecondSession(),
  );
  const messages = page.locator(".pending-text");
  await expect(messages).toHaveText(["Second prompt 1", "Second prompt 2"]);
  await endDrag(page, "pointerup");
  await expect(messages).toHaveText(["Second prompt 1", "Second prompt 2"]);
  await expect(page.locator(".pending-queue-list")).not.toHaveClass(/is-dragging/);
});

test("queue context menus edit and remove only their captured message", async ({ page }) => {
  const rows = page.locator(".pending-item");
  await rows.last().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await menu.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message Harness" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("First prompt 2");
  await rows.last().getByRole("button", { name: /Edit queued message/ }).press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(page.locator(".pending-text")).toHaveText(["First prompt 1"]);
  await expect(input).toBeFocused();
  await rows.first().click({ button: "right" });
  await page.evaluate(async () => (await import("/tests/chat-queue-drag-ownership.fixture.ts")).selectSecondSession());
  await expect(menu).toBeHidden();
  await expect(page.locator(".pending-text")).toHaveText(["Second prompt 1", "Second prompt 2"]);
});
