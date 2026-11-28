import { expect, test } from "@playwright/test";

for (const destination of ["terminal", "chat", "menu", "dialog"] as const) {
  test(`late terminal creation respects the user's ${destination} focus`, async ({ page }) => {
    const release = Promise.withResolvers<void>();
    let requested = false;
    const terminal = {
      id: "focus-terminal",
      title: "Focus terminal",
      cwd: "/workspace",
      pid: 1,
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
    };
    await page.route("**/api/terminals", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: [] });
      requested = true;
      await release.promise;
      await route.fulfill({ json: terminal });
    });
    await page.routeWebSocket("**/ws/terminals/*", (socket) => {
      socket.send(JSON.stringify({ type: "snapshot", info: terminal, data: "Ready\r\n" }));
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Open command palette", exact: true })
      .press("ControlOrMeta+n");
    const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
    await expect(composer).toBeVisible();
    await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Manage", exact: true });
    try {
      await expect.poll(() => requested).toBe(true);
      if (destination === "chat") {
        await composer.click();
        await composer.fill("Keep typing");
      } else if (destination === "menu") {
        await page.getByRole("button", { name: "Manage", exact: true }).click();
        await page.keyboard.press("ArrowDown");
        await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      } else if (destination === "dialog") {
        await page.getByRole("button", { name: "Open folder as workspace", exact: true }).click();
        await expect(page.getByRole("combobox", { name: "Path", exact: true })).toBeFocused();
      }
      release.resolve();
      const input = page.locator(".xterm-helper-textarea:visible");
      await expect(input).toBeVisible();
      if (destination === "terminal") await expect(input).toBeFocused();
      else if (destination === "chat") {
        await expect(composer).toBeFocused();
        await page.keyboard.type(" here");
        await expect(composer).toHaveValue("Keep typing here");
      } else if (destination === "menu") {
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      } else {
        await expect(page.getByRole("combobox", { name: "Path", exact: true })).toBeFocused();
      }
    } finally {
      release.resolve();
    }
  });
}

test("explicit terminal creation and selection focus the requested shell", async ({ page }) => {
  let created = 0;
  await page.route("**/api/terminals", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    const index = ++created;
    return route.fulfill({
      json: {
        id: `explicit-terminal-${index}`,
        title: `Shell ${index}`,
        cwd: "/workspace",
        pid: index,
        cols: 80,
        rows: 24,
        exited: false,
        exitCode: null,
      },
    });
  });
  await page.routeWebSocket("**/ws/terminals/*", (socket) => {
    socket.send(
      JSON.stringify({
        type: "snapshot",
        info: { cols: 80, rows: 24, exited: false, exitCode: null },
        data: "Ready\r\n",
      }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
  const input = page.locator(".xterm-helper-textarea:visible");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "New Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Shell 2", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(input).toBeFocused();
  const first = page.getByRole("button", { name: "Shell 1", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(input).toBeFocused();
  await first.click();
  await expect(input).toBeFocused();
});
