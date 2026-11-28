import { expect, test } from "@playwright/test";

test("Tab keeps the focused conversation row actions visible", async ({ page }) => {
  await page.goto("/tests/conversation-tree-action-focus.fixture.html");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await expect(tree).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tree).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const row = tree.getByRole("treeitem", { name: /^Second conversation\b/ });
  const actions = row.getByRole("toolbar", { name: "Actions for Second conversation" });
  const rename = actions.getByRole("button", { name: "Rename conversation" });
  const remove = actions.getByRole("button", { name: "Delete conversation" });
  await expect(rename).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(rename).toBeFocused();
  await expect(actions).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await expect(actions).toBeVisible();
});
