import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/quick-input-request-owner-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/quick-input-request-owner-fixture");
});

function results(page: Page) {
  return page.evaluate(async () =>
    (await import("/tests/quick-input-request-owner.fixture.ts")).results(),
  );
}

test("replacing an input publishes each request and its resolver together", async ({ page }) => {
  const observed = await page.evaluate(async () =>
    (await import("/tests/quick-input-request-owner.fixture.ts")).replaceInput(),
  );
  expect(observed).toEqual(["Replacement", "Nested"]);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Nested");
  await dialog.getByRole("textbox").press("Enter");
  expect(await results(page)).toEqual([undefined, undefined, "nested response"]);
});

test("disposing input prevents observers from reopening a prompt on the retired service", async ({
  page,
}) => {
  await page.evaluate(async () =>
    (await import("/tests/quick-input-request-owner.fixture.ts")).disposeInput(),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await results(page)).toEqual([undefined, undefined]);
});

test("confirming a multi-select prompt resolves its own request", async ({ page }) => {
  const selection = page.evaluate(async () =>
    (await import("/tests/quick-input-request-owner.fixture.ts")).showMultiple(),
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Choose folders");
  await expect(dialog.getByRole("checkbox", { name: "Alpha" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Beta" }).check();
  await dialog.getByRole("button", { name: "OK" }).click();
  expect(await selection).toEqual(["Alpha", "Beta"]);
});
