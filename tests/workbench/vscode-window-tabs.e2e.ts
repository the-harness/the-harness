import { expect, test } from "@playwright/test";

test("VS Code tabs follow real Dockview groups and dirty document close decisions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard unsaved changes in first.ts?");
    if (++dialogs === 1) await dialog.dismiss();
    else await dialog.accept();
  });
  await page.goto("/");
  const result = await page.evaluate(
    async (moduleUrl) => (await import(moduleUrl)).observeWindowTabs(),
    "/tests/vscode-window-tabs.fixture.ts",
  );
  expect(result).toMatchObject({
    preview: true,
    dirty: true,
    moved: true,
    cancelled: false,
    remained: true,
    accepted: true,
    removed: true,
    path: "/fixture/first.ts",
  });
  expect(result.events).toContainEqual([1, 0, 0]);
  expect(result.events).toContainEqual([0, 1, 0]);
  expect(result.events).toContainEqual([0, 0, 1]);
  expect(dialogs).toBe(2);
  expect(errors).toEqual([]);
});
