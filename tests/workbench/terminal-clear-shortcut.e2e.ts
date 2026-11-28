import { expect, test } from "@playwright/test";

test("clearing a focused terminal keeps the command palette closed", async ({ page, request }) => {
  const title = `Terminal shortcut ${crypto.randomUUID()}`;
  const created = await request.post("/api/terminals", {
    data: { title, shell: "/bin/sh", args: ["-s"] },
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const terminal = `/api/terminals/${encodeURIComponent(id)}`;

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle bottom panel" }).click();
    await page.getByRole("button", { name: title }).click();

    const output = await request.post(`${terminal}/input`, {
      data: {
        data: "i=0; while [ \"$i\" -lt 120 ]; do echo 'Terminal output'; i=$((i+1)); done\n",
      },
    });
    expect(output.status()).toBe(204);
    const screen = page.locator(".xterm:visible");
    const viewport = screen.locator(".xterm-viewport");
    const scrollback = () =>
      viewport.evaluate((element) => element.scrollHeight - element.clientHeight);
    await expect.poll(scrollback).toBeGreaterThan(100);

    const input = screen.locator(".xterm-helper-textarea");
    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    await expect.poll(scrollback).toBe(0);

    const palette = page.getByRole("combobox", { name: "Search commands", exact: true });
    await expect(palette).toHaveCount(0);
    await expect(input).toBeFocused();

    await page.getByRole("button", { name: "Open command palette", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();
  } finally {
    await request.delete(terminal);
  }
});
