import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

const primary = (page: Page) => page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
const auxiliary = (page: Page) => page.getByRole("button", { name: "Toggle workspace panel", exact: true });
const composer = (page: Page) => page.getByRole("textbox", { name: "Message Harness", exact: true });
const primaryPane = (page: Page) => page.getByRole("region", { name: "Conversations", exact: true });
const auxiliaryPane = (page: Page) => page.getByRole("region", { name: "Files", exact: true });

async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open command palette", exact: true }).press("ControlOrMeta+n");
  await expect(composer(page)).toBeVisible();
}

async function resize(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
}

async function expectInside(page: Page) {
  await expect.poll(() => page.locator(".dv-groupview:visible").evaluateAll((groups) => {
    return groups.filter((group) => !group.closest('[inert]')).every((group) => {
      const bounds = group.getBoundingClientRect();
      return bounds.x >= -1 && bounds.right <= innerWidth + 1;
    });
  })).toBe(true);
}

test("resizing hides auxiliary then primary and restores widths without stealing editor focus", async ({ page }) => {
  await open(page);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
  const leftWidth = (await primaryPane(page).boundingBox())!.width;
  const rightWidth = (await auxiliaryPane(page).boundingBox())!.width;
  await composer(page).fill("Keep my draft");
  await resize(page, 700);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await expectInside(page);
  await resize(page, 390);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(composer(page)).toBeFocused();
  await expectInside(page);
  await resize(page, 1440);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.width).toBeCloseTo(leftWidth, 0);
  await expect.poll(async () => (await auxiliaryPane(page).boundingBox())!.width).toBeCloseTo(rightWidth, 0);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("Keep my draft");
});

test("manual closing survives resizing and reload while automatic hiding does not become permanent", async ({ page }) => {
  await open(page);
  await primary(page).click();
  await resize(page, 390);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("harness.layout.v1") ?? "null");
    const find = (node: any): any => node.type === "branch"
      ? node.data.map(find).find(Boolean)
      : node.data.views.includes("files") ? node : undefined;
    return saved && find(saved.grid.root)?.visible;
  })).toBe(true);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await resize(page, 1440);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
});

test("narrow first load keeps both sidebar controls usable and Escape returns to the editor", async ({ page }) => {
  await resize(page, 390);
  await open(page);
  await expect(composer(page)).toBeVisible();
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await composer(page).fill("Narrow draft");
  await primary(page).click();
  await expect(primaryPane(page)).toBeVisible();
  await expect(composer(page)).not.toBeVisible();
  await expectInside(page);
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("Narrow draft");
  await auxiliary(page).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  await expectInside(page);
  await auxiliary(page).click();
  await expect(composer(page)).toBeVisible();
  await resize(page, 1440);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
});

test("a deliberate auxiliary open takes priority without reopening on one-pixel oscillation", async ({ page }) => {
  await open(page);
  await resize(page, 700);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await auxiliary(page).click();
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  for (const width of [701, 700, 701, 700]) {
    await resize(page, width);
    await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
    await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  }
  await expectInside(page);
  await resize(page, 1440);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
});

test("restoring a sidebar requires spare space beyond the collapse boundary", async ({ page }) => {
  await open(page);
  await resize(page, 757);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  for (const width of [758, 759, 758, 789]) {
    await resize(page, width);
    await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  }
  await resize(page, 790);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
  await expectInside(page);
});

test("auto hiding a focused tree returns focus to the editor and widening does not take it back", async ({ page }) => {
  await open(page);
  await composer(page).fill("Focus stays here");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.focus();
  await resize(page, 390);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(composer(page)).toBeFocused();
  await resize(page, 1440);
  await expect(tree).toBeVisible();
  await expect(composer(page)).toBeFocused();
});

test("moving hidden primary to the right preserves visibility and logical collapse priority", async ({ page }) => {
  await open(page);
  await resize(page, 390);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("navigation", { name: "Workbench views" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move Primary Side Bar Right", exact: true }).click();
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await resize(page, 700);
  await expect(primary(page)).toHaveAttribute("aria-pressed", "true");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  expect((await primaryPane(page).boundingBox())!.x).toBeGreaterThan((await composer(page).boundingBox())!.x);
  await expectInside(page);
});

test("activity bar positions recalculate actual available width", async ({ page }) => {
  await open(page);
  await resize(page, 757);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await resize(page, 770);
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  const title = page.getByRole("heading", { name: "Conversations", exact: true });
  const bounds = (await title.boundingBox())!;
  await page.mouse.click(bounds.x + 10, bounds.y + bounds.height / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Activity Bar Position", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "Top", exact: true }).click();
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "true");
  await expectInside(page);
});

test("bottom panel remains visible when horizontal sidebars collapse", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  await resize(page, 390);
  await expect(terminal).toBeVisible();
  await expect(primary(page)).toHaveAttribute("aria-pressed", "false");
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await expectInside(page);
});

test("user sidebar width survives temporary full-width opening and closing", async ({ page }) => {
  await open(page);
  const bounds = (await primaryPane(page).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 70, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.width).toBeGreaterThan(300);
  const preferredWidth = (await primaryPane(page).boundingBox())!.width;
  await resize(page, 390);
  await primary(page).click();
  await expect(primaryPane(page)).toBeVisible();
  await primary(page).click();
  await expect(composer(page)).toBeVisible();
  await resize(page, 1440);
  await primary(page).click();
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.width).toBeCloseTo(preferredWidth, 0);
});

async function dragHeading(page: Page, name: string, destination: { x: number; y: number }) {
  const source = (await page.getByRole("heading", { name, exact: true }).boundingBox())!;
  await page.mouse.move(source.x + 70, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 20 });
  await page.mouse.up();
}

test("a primary sidebar docked below the editor stays visible on a narrow screen", async ({ page }) => {
  await open(page);
  const chat = (await page.getByRole("region", { name: "Chat", exact: true }).boundingBox())!;
  await dragHeading(page, "Conversations", { x: chat.x + chat.width / 2, y: chat.y + chat.height - 12 });
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.y).toBeGreaterThan(200);
  await resize(page, 390);
  await expect(primaryPane(page)).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
  await expectInside(page);
});

test("sidebars stacked in the same column settle at one width without layout oscillation", async ({ page }) => {
  await open(page);
  const files = (await auxiliaryPane(page).boundingBox())!;
  await dragHeading(page, "Conversations", { x: files.x + files.width / 2, y: files.y + files.height - 12 });
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.y).toBeGreaterThan(200);
  await expect.poll(async () => (await primaryPane(page).boundingBox())!.width).toBeCloseTo(290, 0);
  await expect.poll(async () => (await auxiliaryPane(page).boundingBox())!.width).toBeCloseTo(290, 0);
  await resize(page, 700);
  await expect(primaryPane(page)).toBeVisible();
  await expect(auxiliaryPane(page)).toBeVisible();
  await expectInside(page);
  const widths = await page.locator('.dv-groupview:not([inert])').evaluateAll(async (groups) => {
    const samples: number[][] = [];
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(requestAnimationFrame);
      samples.push(groups.map((group) => group.getBoundingClientRect().width));
    }
    return samples;
  });
  expect(new Set(widths.map((sample) => JSON.stringify(sample))).size).toBe(1);
});

test("a terminal moved to a side can be opened temporarily at phone width", async ({ page }) => {
  await open(page);
  const toggle = page.getByRole("button", { name: "Toggle bottom panel", exact: true });
  await toggle.click();
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  const chat = (await page.getByRole("region", { name: "Chat", exact: true }).boundingBox())!;
  await dragHeading(page, "Terminal", { x: chat.x + 12, y: chat.y + chat.height / 2 });
  await expect.poll(async () => (await terminal.boundingBox())!.y).toBeCloseTo(chat.y, 0);
  await resize(page, 390);
  await expect(terminal).toBeHidden();
  await toggle.click();
  await expect(terminal).toBeVisible();
  await expect(composer(page)).toBeHidden();
  await expectInside(page);
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeVisible();
});

test("choosing a conversation returns from the temporary sidebar and dismissing a menu does not", async ({ page }) => {
  await open(page);
  await resize(page, 390);
  await primary(page).click();
  const selected = page.getByRole("tree", { name: "Conversations", exact: true }).getByRole("treeitem", { selected: true });
  await selected.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(primaryPane(page)).toBeVisible();
  await selected.click();
  await expect(composer(page)).toBeFocused();
  await expect(primaryPane(page)).toBeHidden();
});

test("narrow reload preserves the last active editor column and original minimum widths", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  const settings = page.getByRole("tab", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const source = (await settings.boundingBox())!;
  const chat = (await page.getByRole("region", { name: "Settings", exact: true }).boundingBox())!;
  await page.mouse.move(source.x + 30, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(chat.x + chat.width - 12, chat.y + chat.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(composer(page)).toBeVisible();
  await settings.click();
  await resize(page, 320);
  await expect(settings).toBeVisible();
  await expect(composer(page)).toBeHidden();
  await expectInside(page);
  await primary(page).click();
  await expect(primaryPane(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const layout = JSON.parse(localStorage.getItem("harness.layout.v1") ?? "null");
    const find = (node: any): any => node.type === "branch"
      ? node.data.map(find).find(Boolean)
      : node.data.views.includes("chat") ? node.data : undefined;
    const leaves = (node: any): any[] => node.type === "branch" ? node.data.flatMap(leaves) : [node.data];
    const groups = layout && leaves(layout.grid.root);
    return layout && find(layout.grid.root)?.minimumWidth === 300 &&
      layout.responsive.lastEditor === groups.find((group: any) => group.views.includes("settings"))?.id &&
      layout.activeGroup === groups.find((group: any) => group.views.includes("sessions"))?.id;
  })).toBe(true);
  await page.reload();
  await expect(settings).toBeVisible();
  await expect(composer(page)).toBeHidden();
  await expectInside(page);
  await resize(page, 1440);
  await expect(composer(page)).toBeVisible();
  await expect(settings).toBeVisible();
});

test("choosing a file returns from the temporary workspace panel without losing the editor on resize", async ({ page }, testInfo) => {
  const errors = await captureBrowserErrors(page);
  const root = testInfo.outputPath("responsive-files");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "notes.txt"), "Keep this file open");
  await open(page);
  const workspace = await page.evaluate(async (root) =>
    (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root), root);
  try {
    await expect(page.getByRole("treeitem", { name: "notes.txt", exact: true })).toBeVisible();
    await resize(page, 390);
    await auxiliary(page).click();
    await page.getByRole("treeitem", { name: "notes.txt", exact: true }).click();
    const lines = page.locator(".file-editor-monaco:visible .view-lines");
    await expect(lines).toHaveText("Keep this file open");
    await expect(auxiliary(page)).toHaveAttribute("aria-pressed", "false");
    for (const width of [320, 480, 600, 900, 1200, 1920, 390]) {
      await resize(page, width);
      await expect(lines).toHaveText("Keep this file open");
      await expectInside(page);
    }
    expect(await errors()).toEqual([]);
  } finally {
    await page.evaluate(async (created) =>
      (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(created), workspace);
  }
});

test("closing the last editor still allows the remaining sidebar columns to fit", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Close Chat", exact: true }).click();
  await resize(page, 320);
  await expectInside(page);
  await expect(page.locator('.dv-groupview:not([inert])')).toHaveCount(1);
  await page.getByRole("button", { name: "Open command palette", exact: true }).press("ControlOrMeta+n");
  await expect(composer(page)).toBeVisible();
  await expectInside(page);
  await resize(page, 1440);
  await expect(primaryPane(page)).toBeVisible();
  await expect(auxiliaryPane(page)).toBeVisible();
});
