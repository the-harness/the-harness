import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/overlay-focus-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/overlay-focus-fixture");
  await page.evaluate(() => import("/tests/overlay-focus.fixture.ts"));
});

async function runCommand(page: Page, name: string) {
  await page.getByRole("button", { name: "Open palette", exact: true }).click();
  const input = page.getByRole("combobox", { name: "Search commands" });
  await input.fill(name);
  await input.press("Enter");
}

test("command palette restores its opener on cancellation and commands without a focus target", async ({
  page,
}) => {
  const opener = page.getByRole("button", { name: "Open palette", exact: true });
  await opener.click();
  await page.getByRole("combobox", { name: "Search commands" }).press("Escape");
  await expect(opener).toBeFocused();
  await runCommand(page, "Record operation");
  await expect(page.getByLabel("Calls")).toHaveText("1");
  await expect(opener).toBeFocused();
  await runCommand(page, "Focus details");
  await expect(page.getByRole("textbox", { name: "Details" })).toBeFocused();
});

test("command palette leaves IME candidate navigation and confirmation to the input method", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open palette", exact: true }).click();
  const input = page.getByRole("combobox", { name: "Search commands" });
  const active = await input.getAttribute("aria-activedescendant");
  for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Enter", "Escape"]) {
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
    expect(prevented).toBe(key === "Escape");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-activedescendant", active!);
    await expect(page.getByLabel("Calls")).toHaveText("0");
  }
  await input.press("Enter");
  await expect(page.getByLabel("Calls")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Open palette", exact: true })).toBeFocused();
});

test("command palette hands focus to another overlay and preserves the original return target", async ({
  page,
}) => {
  const opener = page.getByRole("button", { name: "Open palette", exact: true });
  await runCommand(page, "Confirm operation");
  const dialog = page.getByRole("alertdialog", { name: "Confirm operation" });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await runCommand(page, "Open quick input");
  const input = page.getByRole("textbox", { name: "Enter value" });
  await expect(input).toBeFocused();
  await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(opener).toBeFocused();
});

test("confirmation restores focus after cancellation, acceptance and queued prompts", async ({
  page,
}) => {
  const opener = page.getByRole("button", { name: "Open confirmation", exact: true });
  await opener.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await expect(opener).toBeFocused();
  await opener.click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(opener).toBeFocused();
  const queue = page.getByRole("button", { name: "Open queued confirmations", exact: true });
  await queue.click();
  await page
    .getByRole("alertdialog", { name: "First confirmation" })
    .getByRole("button", { name: "Continue" })
    .click();
  const second = page.getByRole("alertdialog", { name: "Second confirmation" });
  await expect(second.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(queue).toBeFocused();
});

test("action menu does not reclaim focus from an action's next-render target", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Focus actions", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Focus details later", exact: true }).click();
  const details = page.getByRole("textbox", { name: "Details" });
  await expect(details).toBeFocused();
  await page.keyboard.type("kept focus");
  await expect(details).toHaveValue("kept focus");
});

test("action menu can open a confirmation and receive focus when it closes", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Focus actions", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Confirm from menu", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Confirm operation" });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("select dismissal preserves focus on the outside field that was clicked", async ({ page }) => {
  const details = page.locator('input[aria-label="Details"]');
  await page.getByRole("combobox", { name: "Choice", exact: true }).click();
  await expect(page.getByRole("option", { name: "One", exact: true })).toBeFocused();
  await details.click();
  await expect(page.getByRole("listbox", { name: "Choice", exact: true })).toBeHidden();
  await expect(details).toBeFocused();
  await page.keyboard.type("outside input");
  await expect(details).toHaveValue("outside input");
});

test("confirmation focuses only its cancel action while opening", async ({ page }) => {
  await page.evaluate(() => {
    const labels: string[] = [];
    Object.assign(window, { confirmationFocus: labels });
    document.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('[role="alertdialog"]')) {
        labels.push(event.target.textContent?.trim() ?? "");
      }
    });
  });
  await page.getByRole("button", { name: "Open choice confirmation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { confirmationFocus: string[] }).confirmationFocus,
    ),
  ).toEqual(["Keep editing"]);
});
