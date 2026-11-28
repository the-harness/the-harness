import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/ui-config-defaults-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("/ui-config-defaults-fixture");
});

test("default contributions publish as one snapshot and restore earlier defaults", async ({
  page,
}) => {
  const result = await page.evaluate(async () =>
    (await import("/tests/ui-config-defaults.fixture.ts")).observeScopedDefaults(),
  );

  expect(result).toEqual({
    contributions: [
      {},
      { "fixture.size": 2, "fixture.enabled": true },
      { "fixture.size": 8, "fixture.enabled": false },
      { "fixture.size": 2, "fixture.enabled": true },
    ],
    afterSnapshotEdit: 2,
    workspace: 6,
    user: 4,
    fallback: 2,
  });
});

test("a registration leaves no defaults when an observer disposes its scope during publication", async ({
  page,
}) => {
  const result = await page.evaluate(async () =>
    (await import("/tests/ui-config-defaults.fixture.ts")).disposeDuringDefaultPublication(),
  );

  expect(result).toEqual({
    published: { "fixture.ready": true, "fixture.count": 42 },
    remaining: {},
    disposed: true,
  });
});
