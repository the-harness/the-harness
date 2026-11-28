import { expect, test } from "@playwright/test";

const terminals = ["First shell", "Second shell"].map((title, index) => ({
  id: `polish-terminal-${index}`,
  title,
  cwd: "/workspace",
  pid: index + 1,
  cols: 80,
  rows: 24,
  exited: false,
  exitCode: null,
}));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/terminals", (route) => route.fulfill({ json: terminals }));
  await page.routeWebSocket("**/ws/terminals/*", (socket) => {
    const terminal = terminals.find((item) => socket.url().endsWith(item.id));
    socket.send(JSON.stringify({ type: "snapshot", info: terminal, data: "Terminal ready\r\n" }));
  });
});

test("terminal row actions are visible to keyboard users and kill only the requested shell", async ({
  page,
}) => {
  const killed: string[] = [];
  await page.route("**/api/terminals/*", (route) => {
    expect(route.request().method()).toBe("DELETE");
    killed.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ status: 204 });
  });
  await page.goto("/tests/terminal-exit.fixture.html");
  const first = page.getByRole("button", { name: "First shell", exact: true });
  const second = page.getByRole("button", { name: "Second shell", exact: true });
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await second.focus();
  await page.keyboard.press("Tab");
  const kill = page
    .getByRole("group", { name: "Second shell", exact: true })
    .getByRole("button", { name: "Kill Terminal", exact: true });
  await expect(kill).toBeFocused();
  await expect(kill).toHaveCSS("opacity", "1");
  await kill.press("Enter");
  await expect(second).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
  expect(killed).toEqual(["polish-terminal-1"]);
  await expect(page.locator("button button")).toHaveCount(0);

  const lastKill = page.getByRole("button", { name: "Kill Terminal", exact: true }).first();
  await lastKill.focus();
  await lastKill.press("Enter");
  await expect(first).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Terminal", exact: true })).toBeFocused();
  expect(killed).toEqual(["polish-terminal-1", "polish-terminal-0"]);
});

test("Escape closes terminal search from every search action and restores terminal focus", async ({
  page,
}) => {
  await page.goto("/tests/terminal-exit.fixture.html");
  const search = page.getByRole("search", { name: "Terminal search" });
  const actions = ["Previous Match", "Next Match", "Close terminal search"];
  for (let index = 0; index < actions.length; index += 1) {
    await page.getByRole("button", { name: "Find (Cmd/Ctrl+F)", exact: true }).click();
    await expect(search.getByRole("textbox")).toBeFocused();
    for (let step = 0; step <= index; step += 1) await page.keyboard.press("Tab");
    const action = search.getByRole("button", { name: actions[index], exact: true });
    await expect(action).toBeFocused();
    await action.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
  }
});

test("terminal context menus target the clicked shell and restore focus after killing it", async ({ page }) => {
  const killed: string[] = [];
  await page.route("**/api/terminals/*", (route) => {
    killed.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ status: 204 });
  });
  await page.goto("/tests/terminal-exit.fixture.html");
  const first = page.getByRole("button", { name: "First shell", exact: true });
  const second = page.getByRole("button", { name: "Second shell", exact: true });
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await second.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kill Terminal", exact: true }).click();
  await expect(second).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-pressed", "true");
  expect(killed).toEqual(["polish-terminal-1"]);
  await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
});

test("terminal content supports keyboard menus, selection and find without overriding search input menus", async ({ page }) => {
  await page.goto("/tests/terminal-exit.fixture.html");
  const input = page.locator(".xterm-helper-textarea:visible");
  await input.focus();
  await input.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Terminal actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "New Terminal", exact: true })).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Select All", exact: true }).click();
  await expect(input).toBeFocused();
  await input.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Find…", exact: true }).click();
  const search = page.getByRole("search", { name: "Terminal search" }).getByRole("textbox");
  await expect(search).toBeFocused();
  await search.click({ button: "right" });
  await expect(menu).toBeHidden();
  await search.press("Escape");
  await expect(input).toBeFocused();
});
