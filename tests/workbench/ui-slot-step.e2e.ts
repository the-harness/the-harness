import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui-slot-step.fixture.html");
});

test("slot updates preserve contributed state and focus independently in each outlet", async ({ page }) => {
  const left = page.getByRole("article", { name: "left" });
  const right = page.getByRole("article", { name: "right" });
  await left.getByRole("button", { name: "used count 0", exact: true }).click();
  await left.getByRole("button", { name: "contributed count 0", exact: true }).click();
  const note = left.getByRole("textbox", { name: "contributed note" });
  await note.fill("keep this note");
  await note.press("ArrowUp");
  await expect(note).toBeFocused();
  await expect(note).toHaveValue("keep this note");
  await expect(left.getByRole("button", { name: "used count 1", exact: true })).toBeVisible();
  await expect(left.getByRole("button", { name: "contributed count 1", exact: true })).toBeVisible();
  await expect(left.locator("output")).toHaveText("Result: 113 left/scoped/used/contributed");
  await expect(right.locator("output")).toHaveText("Result: 131 right/scoped/used/contributed");
  await expect(right.getByRole("button", { name: "contributed count 0", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Update terminal" }).click();
  await expect(left.locator("output")).toHaveText("Updated: 113 left/scoped/used/contributed");
});

test("slot insertion does not transfer state between registrations of the same component", async ({ page }) => {
  const left = page.getByRole("article", { name: "left" });
  await left.getByRole("button", { name: "used count 0", exact: true }).click();
  await page.getByRole("button", { name: "Insert before", exact: true }).click();
  await expect(left.getByRole("button", { name: "used count 0", exact: true })).toHaveCount(2);
  await expect(left.locator("output")).toHaveText("Result: 113 left/scoped/used/used/contributed");
  await page.getByRole("button", { name: "Remove inserted" }).click();
  await expect(left.getByRole("button", { name: "used count 0", exact: true })).toHaveCount(1);

  await left.getByRole("button", { name: "used count 0", exact: true }).click();
  await page.getByRole("button", { name: "Insert after", exact: true }).click();
  await expect(left.getByRole("button", { name: "used count 1", exact: true })).toHaveCount(1);
  await expect(left.getByRole("button", { name: "used count 0", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Remove inserted" }).click();
  await expect(left.getByRole("button", { name: "used count 1", exact: true })).toHaveCount(1);
  await expect(left.locator("output")).toHaveText("Result: 112 left/scoped/used/contributed");
});

test("unmounting a contribution removes it from every outlet and it can register again", async ({ page }) => {
  await page.getByRole("button", { name: "Toggle contribution" }).click();
  await expect(page.getByRole("textbox", { name: "contributed note" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "left" }).locator("output"))
    .toHaveText("Result: 12 left/scoped/used");
  await page.getByRole("button", { name: "Toggle contribution" }).click();
  await expect(page.getByRole("textbox", { name: "contributed note" })).toHaveCount(2);
  await expect(page.getByRole("article", { name: "left" }).locator("output"))
    .toHaveText("Result: 112 left/scoped/used/contributed");
});
