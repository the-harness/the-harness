import { expect, test } from "@playwright/test";

test("the extension registry observes scoped changes and rejects direct deletion", async ({
  page,
}) => {
  await page.goto("/tests/workbench-registry-views.fixture.html");
  const result = await page.evaluate(async () =>
    (await import("/tests/workbench-registry-views.fixture.ts")).exerciseExtensionRegistry(),
  );
  expect(result).toEqual({
    bypassed: false,
    retained: true,
    counts: [0, 1, 0],
  });
});
