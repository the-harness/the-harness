import { expect, test } from "@playwright/test";

test("only a mounted terminal panel creates a shell after loading an empty inventory", async ({
  page,
}) => {
  await page.route("**/terminal-panel-activation-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("/terminal-panel-activation-fixture");
  const activation = await page.evaluate(async () =>
    (await import("/tests/terminal-panel-activation.fixture.ts")).observePanelActivation(),
  );
  expect(activation).toEqual({ inventoryPending: true, afterUnmount: 0, afterRemount: 1 });
});

test("reopening the terminal panel shares the pending default shell but allows requesting another", async ({
  page,
}) => {
  const initialShell = Promise.withResolvers<void>();
  let inventoryReads = 0;
  let creationRequests = 0;
  await page.route("**/api/terminals", async (route) => {
    if (route.request().method() === "GET") {
      inventoryReads += 1;
      await route.fulfill({ json: [] });
      return;
    }
    const index = ++creationRequests;
    if (index === 1) await initialShell.promise;
    await route.fulfill({
      json: {
        id: `shell-${index}`,
        title: index === 1 ? "Default shell" : "Explicit shell",
        cwd: "/workspace",
        pid: index,
        cols: 80,
        rows: 24,
        exited: false,
        exitCode: null,
      },
    });
  });
  await page.routeWebSocket("**/ws/terminals/*", () => {});
  await page.goto("/");
  const requests = () => ({ inventoryReads, creationRequests });
  const toggle = page.getByRole("button", { name: "Toggle bottom panel", exact: true });
  const newTerminal = page.getByRole("button", { name: "New Terminal", exact: true });
  try {
    await toggle.click();
    await expect(newTerminal).toBeVisible();
    await expect.poll(requests).toEqual({ inventoryReads: 1, creationRequests: 1 });

    await toggle.click();
    await expect(newTerminal).toHaveCount(0);
    await toggle.click();
    await expect(newTerminal).toBeVisible();
    await expect(page.getByText("No active terminals", { exact: true })).toBeVisible();
    await expect.poll(requests).toEqual({ inventoryReads: 1, creationRequests: 1 });

    await newTerminal.click();
    await expect(page.getByRole("button", { name: "Explicit shell", exact: true })).toBeVisible();
    initialShell.resolve();
    await expect(page.getByRole("button", { name: "Default shell", exact: true })).toBeVisible();
    expect(requests()).toEqual({ inventoryReads: 1, creationRequests: 2 });
  } finally {
    initialShell.resolve();
  }
});
