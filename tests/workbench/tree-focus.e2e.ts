import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/tree-focus.fixture.html");
});

test("tree roots have no extra indent and children keep one compact indent step", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const root = tree.getByRole("treeitem", { name: "Workspace", exact: true });
  const child = tree.getByRole("treeitem", { name: /^Conversation 1,/ });
  const bounds = await tree.boundingBox();
  expect(bounds).not.toBeNull();
  const rootIcon = await root.locator(".vc-tree-node-icon").boundingBox();
  const childIcon = await child.locator(".vc-tree-node-icon").boundingBox();
  const arrow = root.locator(".vc-twistie-icon");
  await expect(root.locator(".vc-tree-twistie")).toHaveCSS("padding-left", "0px");
  expect(rootIcon!.x - bounds!.x).toBe(20);
  expect(childIcon!.x - rootIcon!.x).toBe(8);
  expect((await child.locator(".vc-tree-indent-guide").boundingBox())!.x - bounds!.x).toBe(8);
  expect((await root.boundingBox())!.width).toBe(bounds!.width);
  await arrow.click();
  await expect(root).toHaveAttribute("aria-expanded", "false");
  await expect(child).toHaveCount(0);
  await arrow.click();
  await expect(child).toBeVisible();
});

test("clicking a tree action transfers focus directly to the action", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await page.getByRole("button", { name: "Before tree", exact: true }).focus();
  await tree.getByRole("treeitem", { name: /^Conversation 2,/ }).hover();
  await page.evaluate(() => {
    const focus: string[] = [];
    (window as unknown as { focusTrace: string[] }).focusTrace = focus;
    document.addEventListener("focusin", (event) => {
      const target = event.target as HTMLElement;
      focus.push(
        target.getAttribute("aria-label") ?? target.getAttribute("role") ?? target.tagName,
      );
    });
  });
  const rename = tree
    .getByRole("treeitem", { name: /^Conversation 2,/ })
    .getByRole("button", { name: "Rename conversation", exact: true });
  await rename.click();
  await expect(rename).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { focusTrace: string[] }).focusTrace))
    .toEqual(["Rename conversation"]);
});

test("collapsing a branch repairs logical focus without stealing DOM focus", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.getByRole("treeitem", { name: /^Conversation 2,/ }).click();
  const collapse = page.getByRole("button", { name: "Collapse workspace", exact: true });
  await collapse.click();
  const parent = tree.getByRole("treeitem", { name: "Workspace", exact: true });
  await expect(tree).toHaveAttribute("aria-activedescendant", (await parent.getAttribute("id"))!);
  await expect(collapse).toBeFocused();
  await tree.focus();
  await tree.press("ArrowDown");
  const next = tree.getByRole("treeitem", { name: "Other workspace", exact: true });
  await expect(tree).toHaveAttribute("aria-activedescendant", (await next.getAttribute("id"))!);
});

test("removing the focused row keeps keyboard navigation at its visible neighbor", async ({
  page,
}) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.getByRole("treeitem", { name: /^Conversation 2,/ }).click();
  const remove = page.getByRole("button", { name: "Remove focused conversation", exact: true });
  await remove.click();
  const next = tree.getByRole("treeitem", { name: /^Conversation 3,/ });
  await expect(tree).toHaveAttribute("aria-activedescendant", (await next.getAttribute("id"))!);
  await expect(remove).toBeFocused();
  await tree.focus();
  await tree.press("ArrowDown");
  const following = tree.getByRole("treeitem", { name: /^Conversation 4,/ });
  await expect(tree).toHaveAttribute(
    "aria-activedescendant",
    (await following.getAttribute("id"))!,
  );
});

test("returning to a scrolled tree reveals its focused row", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const row = tree.getByRole("treeitem", { name: /^Conversation 2,/ });
  await row.click();
  const id = (await row.getAttribute("id"))!;
  await tree.hover();
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 900);
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Before tree", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(tree).toBeFocused();
  await expect(tree).toHaveAttribute("aria-activedescendant", id);
  await expect(row).toBeVisible();
});

test("Home and End move tree focus to visible edges without changing selection", async ({
  page,
}) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.getByRole("treeitem", { name: /^Conversation 2,/ }).click();
  await tree.press("End");
  const last = tree.getByRole("treeitem", { name: "Other workspace", exact: true });
  await expect(last).toBeVisible();
  await expect(tree).toHaveAttribute("aria-activedescendant", (await last.getAttribute("id"))!);
  await tree.press("Home");
  const first = tree.getByRole("treeitem", { name: "Workspace", exact: true });
  await expect(first).toBeVisible();
  await expect(tree).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
  await expect(tree.getByRole("treeitem", { name: /^Conversation 2,/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("clicking another row after scrolling does not reveal the previously focused row", async ({
  page,
}) => {
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.getByRole("treeitem", { name: /^Conversation 2,/ }).click();
  await tree.hover();
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 900);
  await expect(tree.getByRole("treeitem", { name: /^Conversation 2,/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Before tree", exact: true }).focus();
  const row = tree.getByRole("treeitem", { name: /^Conversation 10,/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(tree).toBeFocused();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(tree).toHaveAttribute("aria-activedescendant", (await row.getAttribute("id"))!);
});
