import { expect, test } from "@playwright/test";

test("panel menus show Output beside Terminal and hide the correct region", async ({ page }) => {
  const terminal = {
    id: "panel-menu-terminal", title: "Panel shell", cwd: "/workspace", pid: 1,
    cols: 80, rows: 24, exited: false, exitCode: null,
  };
  await page.route("**/api/terminals", (route) => route.fulfill({ json: [terminal] }));
  await page.routeWebSocket("**/ws/terminals/*", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", info: terminal, data: "Ready\r\n" }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
  await page.getByRole("button", { name: "Clear output", exact: true }).press("Shift+F10");
  const menu = page.getByRole("menu", { name: "View actions", exact: true });
  const output = menu.getByRole("menuitemcheckbox", { name: "Output", exact: true });
  await expect(output).toHaveAttribute("aria-checked", "false");
  await output.click();
  const outputTab = page.getByRole("tab", { name: "Output", exact: true });
  await expect(outputTab).toBeVisible();
  await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();
  await outputTab.click({ button: "right" });
  await expect(output).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitem", { name: "Hide Panel", exact: true }).click();
  await expect(outputTab).toBeHidden();
  await expect(page.getByRole("button", { name: "Toggle bottom panel", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("title and view headers expose layout actions from mouse and keyboard", async ({ page }) => {
  await page.route("**/api/terminals", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Toggle workspace panel", exact: true });
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await toggle.focus();
  await toggle.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Title Bar actions", exact: true });
  await expect(menu.getByRole("menuitemcheckbox", { name: "Primary Side Bar", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();

  await page.locator(".titlebar").click({ button: "right", position: { x: 10, y: 10 } });
  await menu.getByRole("menuitemcheckbox", { name: "Secondary Side Bar", exact: true }).click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await expect(files).toBeVisible();
  await files.click({ button: "right" });
  const viewMenu = page.getByRole("menu", { name: "View actions", exact: true });
  await expect(viewMenu.getByRole("menuitemcheckbox", { name: "Files", exact: true })).toHaveAttribute("aria-checked", "true");
  await viewMenu.getByRole("menuitem", { name: "Hide Secondary Side Bar", exact: true }).click();
  await expect(files).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("status bar choices remain reachable after hiding an item and survive reload", async ({ page }) => {
  await page.goto("/");
  const bar = page.getByLabel("Status Bar", { exact: true });
  await bar.click({ button: "right", position: { x: 80, y: 10 } });
  const model = page.getByRole("menuitemcheckbox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-checked", "true");
  await model.click();
  await page.reload();
  await bar.focus();
  await bar.press("Shift+F10");
  await expect(model).toHaveAttribute("aria-checked", "false");
  await model.click();
  await bar.press("Shift+F10");
  await expect(model).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(bar).toBeFocused();
});
