import { expect, test } from "@playwright/test";

test("tab renderers follow their own scope during replacement and publication", async ({
  page,
}) => {
  await page.route("**/tab-renderer-ownership-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("/tab-renderer-ownership-fixture");
  const ownership = await page.evaluate(async () =>
    (await import("/tests/tab-renderer-ownership.fixture.ts")).observeRendererOwnership(),
  );
  expect(ownership).toEqual({
    replacementRetained: true,
    replacementReleased: true,
    published: true,
    disposedDuringPublication: true,
    releasedDuringPublication: true,
  });
});
