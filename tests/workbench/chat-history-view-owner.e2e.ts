import { expect, test } from "@playwright/test";

test("pending history stays with its conversation when the chat view switches", async ({
  page,
}) => {
  await page.route("**/chat-history-view-owner-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/chat-history-view-owner-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-history-view-owner.fixture.ts")).mountChat(),
  );

  const earlier = page.getByRole("button", { name: /Load(?:ing)? earlier messages/ });
  await expect(page.getByText("First latest prompt", { exact: true })).toBeVisible();
  await earlier.click();
  await expect(earlier).toBeDisabled();

  await page.evaluate(async () =>
    (await import("/tests/chat-history-view-owner.fixture.ts")).switchWhileLoading(),
  );
  await expect(page.getByText("Second latest prompt", { exact: true })).toBeVisible();
  await expect(earlier).toBeEnabled();
  await earlier.click();
  await expect(earlier).toBeDisabled();

  await page.evaluate(async () =>
    (await import("/tests/chat-history-view-owner.fixture.ts")).finishFirstWhileSecondLoads(),
  );
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import("/tests/chat-history-view-owner.fixture.ts")).firstHistoryLoaded(),
      ),
    )
    .toBe(true);
  await expect(earlier).toBeDisabled();
  await expect(page.getByText("First older prompt", { exact: true })).toHaveCount(0);

  await page.evaluate(async () =>
    (await import("/tests/chat-history-view-owner.fixture.ts")).finishSecond(),
  );
  await expect(page.getByText("Second older prompt", { exact: true })).toBeVisible();
});
