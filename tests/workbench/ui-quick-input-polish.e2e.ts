import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, preselected = false) {
  await page.route("**/quick-input-polish-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/quick-input-polish-fixture");
  await page.evaluate(
    async (preselected) =>
      (await import("/tests/ui-quick-input-polish.fixture.ts")).mount(preselected),
    preselected,
  );
}

function result(page: Page) {
  return page.evaluate(async () =>
    (await import("/tests/ui-quick-input-polish.fixture.ts")).result(),
  );
}

test("quick pick follows keyboard selection, scrolls it into view and restores focus", async ({
  page,
}) => {
  await mount(page);
  const opener = page.getByRole("button", { name: "Open picker", exact: true });
  await opener.click();
  const input = page.getByRole("combobox", { name: "Choose a candidate" });
  await expect(input).toBeFocused();
  await expect(page.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  const initialActive = await input.getAttribute("aria-activedescendant");
  for (const key of ["ArrowDown", "ArrowUp"]) {
    const prevented = await input.evaluate((element, key) => {
      const event = new KeyboardEvent("keydown", {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, key);
    expect(prevented).toBe(false);
    await expect(input).toHaveAttribute("aria-activedescendant", initialActive!);
  }
  await input.press("ArrowDown");
  await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toBeVisible();
  await input.press("Enter");
  expect(await result(page)).toMatchObject({ label: "Candidate 02" });
  await expect(opener).toBeFocused();

  await opener.click();
  await input.press("ArrowUp");
  const last = page.getByRole("option").last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport();
  await expect
    .poll(() => page.getByRole("listbox").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await input.fill("no matching candidate");
  await expect(page.getByRole("status")).toHaveText("No matching items");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.press("Enter");
  await expect(input).toBeVisible();
  await input.press("Escape");
  expect(await result(page)).toBeUndefined();
  await expect(opener).toBeFocused();
});

test("multi-select cancels from checkboxes and keeps keyboard focus inside the prompt", async ({
  page,
}) => {
  await mount(page);
  const opener = page.getByRole("button", { name: "Open multiple picker", exact: true });
  await opener.click();
  const first = page.getByRole("checkbox", { name: "Candidate 01 Description 1", exact: true });
  await expect(first).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await first.press("Escape");
  expect(await result(page)).toBeUndefined();
  await expect(opener).toBeFocused();

  await opener.click();
  const confirm = page.getByRole("button", { name: "OK", exact: true });
  await confirm.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox")).toBeFocused();
  await page.getByRole("checkbox", { name: "Candidate 02 Description 2", exact: true }).check();
  await confirm.click();
  expect(await result(page)).toMatchObject([{ label: "Candidate 01" }, { label: "Candidate 02" }]);
});

test("a pending multi-select preserves preselected items when mounted in a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await mount(page, true);
  await expect(
    page.getByRole("checkbox", { name: "Candidate 01 Description 1", exact: true }),
  ).toBeChecked();
  const dialog = page.getByRole("dialog", { name: "Choose a candidate" });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480);
  await expect(page.getByRole("button", { name: "OK", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  expect(await result(page)).toMatchObject([{ label: "Candidate 01" }]);
});
