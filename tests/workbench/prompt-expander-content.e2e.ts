import { expect, test } from "@playwright/test";

test("removes the expander when a reused prompt loses its text", async ({ context, page }) => {
  await context.route("**/prompt-expander-content-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="app"></div><script type="module" src="/tests/prompt-expander-content.fixture.ts"></script>',
    }),
  );
  await page.goto("/prompt-expander-content-fixture");
  const peer = await context.newPage();
  await peer.goto("/prompt-expander-content-fixture");
  const toggle = page.getByRole("button", { name: "Show more", exact: true });
  await expect(toggle).toBeVisible();
  const textId = (await toggle.getAttribute("aria-controls"))!;

  await peer.getByRole("button", { name: "Clear prompt text" }).click();
  await expect(page.locator(".u-text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview replacement.png" })).toBeVisible();
  await expect(toggle).toHaveCount(0);

  await peer.getByRole("button", { name: "Restore prompt text" }).click();
  await expect(toggle).toHaveAttribute("aria-controls", textId);
});
