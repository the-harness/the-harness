import { expect, test } from "@playwright/test";

test("workbench icons have SVG masks and visible dimensions", async ({ page }) => {
  await page.goto("/");

  for (const name of ["search", "comment-discussion", "settings-gear"]) {
    const icon = page.locator(`.i-codicon-${name}`).first();
    await expect(icon).toHaveCSS("mask-image", /url\(.+image\/svg\+xml/);
    const bounds = await icon.boundingBox();
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
  }
});
