import { expect, test } from "@playwright/test";

test("enabled contributions and their docked layout survive a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("button", { name: "Enable extension", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Workspace notes", exact: true })
    .fill("Persistent notes");
  await expect(
    page.getByRole("button", { name: "Open workspace notes", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("harness.layout.v1")))
    .toContain("notes");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Workspace notes", exact: true })).toHaveValue(
    "Persistent notes",
  );
  await expect(
    page.getByRole("button", { name: "Open workspace notes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("button", { name: "Disable extension", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open workspace notes", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("tab", { name: "Notes", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("keeps a replacement extension registered under the same id when the previous registration is disposed", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (moduleUrl) => {
    const { effectScope, createWorkbench } = (await import(
      moduleUrl
    )) as typeof import("../../apps/web/tests/workbench.fixture.ts");
    const workbench = createWorkbench();
    const firstScope = effectScope();
    firstScope.run(() => {
      workbench.use({
        id: "workspace.custom",
        panels: [
          {
            id: "first",
            title: "First",
            icon: "i-codicon-file",
            component: {},
            location: "right",
          },
        ],
      });
    });
    const secondScope = effectScope();
    secondScope.run(() => {
      workbench.use({
        id: "workspace.custom",
        panels: [
          {
            id: "second",
            title: "Second",
            icon: "i-codicon-file",
            component: {},
            location: "right",
          },
        ],
      });
    });
    firstScope.stop();
    return workbench.panels().map((panel) => panel.id);
  }, "/tests/workbench.fixture.ts");
  expect(result).toEqual(["second"]);
});
