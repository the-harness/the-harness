import { expect, test, type Page } from "@playwright/test";

function showInput(page: Page, title: string, value: string) {
  return page.evaluate(
    async ({ title, value }) =>
      (await import("/tests/quick-input-mount-state.fixture.ts")).showInput(title, value),
    { title, value },
  );
}

function inputResult(page: Page, title: string) {
  return page.evaluate(
    async (title) => (await import("/tests/quick-input-mount-state.fixture.ts")).inputResult(title),
    title,
  );
}

test("QuickInput reflects requests already active when its host mounts", async ({ page }) => {
  await page.route("**/quick-input-mount-state-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/quick-input-mount-state-fixture");
  const mount = () =>
    page.evaluate(async () =>
      (await import("/tests/quick-input-mount-state.fixture.ts")).mountModal(),
    );
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox");

  await showInput(page, "Queued input", "existing value");
  await mount();
  await expect(input).toHaveValue("existing value");
  await page.evaluate(async () =>
    (await import("/tests/quick-input-mount-state.fixture.ts")).unmountModal(),
  );
  await expect(dialog).toHaveCount(0);
  await mount();
  await expect(input).toHaveValue("existing value");
  await input.press("Enter");
  expect(await inputResult(page, "Queued input")).toBe("existing value");

  await showInput(page, "First live input", "first value");
  await expect(input).toHaveValue("first value");
  await showInput(page, "Replacement input", "replacement value");
  await expect(input).toHaveValue("replacement value");
  expect(await inputResult(page, "First live input")).toBeUndefined();
  await input.press("Enter");
  expect(await inputResult(page, "Replacement input")).toBe("replacement value");
  await expect(dialog).toHaveCount(0);
});
