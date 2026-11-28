import { expect, test, type Page } from "@playwright/test";

const fixture = "/tests/workbench-preferences.fixture.ts";

async function openWorkbench(page: Page): Promise<void> {
  await page.route("**/workbench-preferences", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Workbench</title>" }),
  );
  await page.goto("/workbench-preferences");
}

function readPreferences(page: Page) {
  return page.evaluate(async (url) => (await import(url)).readPreferences(), fixture);
}

test("keeps theme and sidebar edits from different windows when a storage event is delayed", async ({
  page,
  context,
}) => {
  await openWorkbench(page);
  expect(await readPreferences(page)).toEqual({ theme: "dark", sidebarLocation: "left" });
  const peer = await context.newPage();
  await openWorkbench(peer);
  await peer.evaluate(async (url) => (await import(url)).delayPreferenceChanges(), fixture);
  expect(await readPreferences(peer)).toEqual({ theme: "dark", sidebarLocation: "left" });

  await page.evaluate(async (url) => (await import(url)).setTheme("light"), fixture);
  await expect
    .poll(() => peer.evaluate(async (url) => (await import(url)).delayedChangeCount(), fixture))
    .toBeGreaterThan(0);
  expect(await readPreferences(peer)).toEqual({ theme: "dark", sidebarLocation: "left" });

  await peer.evaluate(async (url) => (await import(url)).setSidebarLocation("right"), fixture);
  const reopened = await context.newPage();
  await openWorkbench(reopened);
  const expected = { theme: "light", sidebarLocation: "right" };
  expect(await readPreferences(reopened)).toEqual(expected);

  await peer.evaluate(async (url) => (await import(url)).releasePreferenceChanges(), fixture);
  await expect.poll(() => readPreferences(page)).toEqual(expected);
  await expect.poll(() => readPreferences(peer)).toEqual(expected);
});

test("reads existing combined workbench preferences when opening a window", async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "harness:core:ui-workbench",
      JSON.stringify({ theme: "light", sidebarLocation: "right" }),
    );
  });
  expect(await readPreferences(page)).toEqual({ theme: "light", sidebarLocation: "right" });
  await page.evaluate(async (url) => (await import(url)).setTheme("dark"), fixture);
  await page.reload();
  expect(await readPreferences(page)).toEqual({ theme: "dark", sidebarLocation: "right" });
});
