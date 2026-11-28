import { expect, test, type Page } from "@playwright/test";

function retireCommand(page: Page, name: string) {
  return page.evaluate(
    async (name) =>
      (await import("/tests/command-palette-selection.fixture.ts")).retireCommand(name),
    name,
  );
}

function invokedCommands(page: Page) {
  return page.evaluate(async () =>
    (await import("/tests/command-palette-selection.fixture.ts")).invokedCommands(),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open command palette", exact: true });
  await expect(trigger).toBeVisible();
  await page.evaluate(async () =>
    (await import("/tests/command-palette-selection.fixture.ts")).registerCommands(),
  );
  await trigger.click();
  await page.getByRole("combobox", { name: "Search commands" }).fill(">Scoped probe");
  await expect(
    page.getByRole("option", { name: "Scoped probe Alpha", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("the command palette keeps the same selected command as other results leave", async ({
  page,
}) => {
  const input = page.getByRole("combobox", { name: "Search commands" });
  const beta = page.getByRole("option", { name: "Scoped probe Beta", exact: true });
  await input.press("ArrowDown");
  await expect(beta).toHaveAttribute("aria-selected", "true");

  await retireCommand(page, "Alpha");
  await expect(page.getByRole("option", { name: "Scoped probe Alpha", exact: true })).toHaveCount(
    0,
  );
  await expect(beta).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect.poll(() => invokedCommands(page)).toEqual(["Beta"]);
});

test("the command palette clears a retired selection until the user selects another", async ({
  page,
}) => {
  const input = page.getByRole("combobox", { name: "Search commands" });
  const beta = page.getByRole("option", { name: "Scoped probe Beta", exact: true });
  await input.press("ArrowDown");
  await expect(beta).toHaveAttribute("aria-selected", "true");

  await retireCommand(page, "Beta");
  await expect(beta).toHaveCount(0);
  await expect(page.getByRole("option", { selected: true })).toHaveCount(0);
  await input.press("Enter");
  await expect(input).toBeVisible();
  expect(await invokedCommands(page)).toEqual([]);

  await input.press("ArrowDown");
  const alpha = page.getByRole("option", { name: "Scoped probe Alpha", exact: true });
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await input.fill(">Scoped probe Gamma");
  await expect(
    page.getByRole("option", { name: "Scoped probe Gamma", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect.poll(() => invokedCommands(page)).toEqual(["Gamma"]);
});
