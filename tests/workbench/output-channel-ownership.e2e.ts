import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/output-channel-ownership-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("/output-channel-ownership-fixture");
});

test("a channel is removed when publication disposes its contributor", async ({ page }) => {
  await page.evaluate(async () =>
    (await import("/tests/output-channel-ownership.fixture.ts")).publishWhileDisposingContributor(),
  );
  const chooser = page.getByRole("combobox", { name: "Output Channel" });
  await expect(chooser).toBeDisabled();
  await expect(chooser.getByRole("option", { name: "Build" })).toHaveCount(0);

  await page.evaluate(async () =>
    (await import("/tests/output-channel-ownership.fixture.ts")).publishBuildOutput(),
  );
  await expect(chooser).toBeEnabled();
  await expect(chooser.locator("option:checked")).toHaveText("Build");
  await expect(page.getByText("Live build output", { exact: true })).toBeVisible();
});

test("retiring the output service clears its selection and rejects new channels", async ({
  page,
}) => {
  const activeId = await page.evaluate(async () => {
    const fixture = await import("/tests/output-channel-ownership.fixture.ts");
    fixture.publishBuildOutput();
    return fixture.retireOutputService();
  });
  expect(activeId).toBeNull();
  await expect(page.getByRole("combobox", { name: "Output Channel" })).toBeDisabled();
  await expect(
    page.evaluate(async () =>
      (await import("/tests/output-channel-ownership.fixture.ts")).publishAfterRetirement(),
    ),
  ).rejects.toThrow("UiOutputService is disposed");
});

test("output content has a keyboard-accessible context menu that clears its own channel", async ({ page }) => {
  await page.evaluate(async () =>
    (await import("/tests/output-channel-ownership.fixture.ts")).publishBuildOutput(),
  );
  const log = page.getByLabel("Output content", { exact: true });
  await log.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Output actions" });
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Select All", exact: true }).click();
  await expect(log).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Live build output");
  await log.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Clear Output", exact: true }).click();
  await expect(log).toBeEmpty();
  await expect(log).toBeFocused();
});
