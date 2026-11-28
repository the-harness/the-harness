import { expect, test, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}

async function openSettingsInEditor(page: Page) {
  await expect(page.getByRole("button", { name: "Manage", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
}

test("settings shows a full-width search and filters settings across categories", async ({
  page,
}) => {
  await page.goto("/");
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("searchbox", { name: "Search settings" });
  const nav = settings.getByRole("navigation", { name: "Settings categories" });
  const results = settings.getByRole("region", { name: "Settings results" });
  const layout = results.getByRole("heading", { name: "Layout", exact: true });
  await expect(search).toBeFocused();

  const searchBounds = (await settings.getByRole("search").boundingBox())!;
  const navBounds = (await nav.boundingBox())!;
  const resultsBounds = (await results.boundingBox())!;
  const categoryBounds = (await nav.getByRole("button", { name: "All settings" }).boundingBox())!;
  expect(searchBounds.height).toBe(26);
  expect(categoryBounds.height).toBe(22);
  expect(categoryBounds.x).toBeCloseTo(searchBounds.x, 1);
  expect(categoryBounds.y).toBeCloseTo(resultsBounds.y, 1);
  expect(searchBounds.y + searchBounds.height).toBeLessThan(navBounds.y);
  expect(navBounds.x + navBounds.width).toBeLessThanOrEqual(resultsBounds.x);
  expect(searchBounds.width).toBeGreaterThan(resultsBounds.width);

  const layoutCategory = nav.getByRole("button", { name: "Layout", exact: true });
  await layoutCategory.click();
  await expect(layoutCategory).toHaveAttribute("aria-pressed", "true");
  await expect(layout).toBeVisible();
  await expect(results.getByRole("combobox", { name: "Color theme" })).toHaveCount(0);

  await search.fill("default requests");
  const all = nav.getByRole("button", { name: "All settings" });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByRole("status")).toHaveText("1 setting");
  await expect(results.getByRole("combobox", { name: "Default model" })).toBeVisible();
  await expect(layout).toHaveCount(0);

  await search.fill("not-a-setting");
  await expect(results.getByText("No settings match “not-a-setting”.")).toBeVisible();
  await expect(settings.getByRole("status")).toHaveText("0 settings");
  await settings.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(layout).toBeVisible();

  await page.setViewportSize({ width: 430, height: 680 });
  await expect(settings).toBeInViewport({ ratio: 1 });
  await expect(nav).toBeInViewport({ ratio: 1 });
  const narrowNav = (await nav.boundingBox())!;
  const narrowResults = (await results.boundingBox())!;
  expect(narrowNav.y + narrowNav.height).toBeLessThanOrEqual(narrowResults.y);
  await layoutCategory.click();
  await expect(layout).toBeVisible();
});

test("settings combobox uses a themed list and supports keyboard selection and cancellation", async ({
  page,
}) => {
  await page.goto("/");
  await openSettings(page);

  const trigger = page.getByRole("combobox", { name: "Color theme", exact: true });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const panel = dialog.locator(".settings-panel");
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText([
    "Appearance",
    "Conversations",
    "Layout",
  ]);
  const controls = panel.getByRole("combobox");
  await expect(controls).toHaveCount(4);
  expect(
    await controls.evaluateAll((elements) =>
      elements.every((element) => {
        const control = element.getBoundingClientRect();
        const label = element.closest(".setting")!.querySelector("strong")!.getBoundingClientRect();
        return control.left === label.left && control.top >= label.bottom && control.height === 26;
      }),
    ),
  ).toBe(true);
  const list = page.getByRole("listbox", { name: "Color theme", exact: true });
  const dark = list.getByRole("option", { name: "Dark 2026" });
  const light = list.getByRole("option", { name: "Light 2026" });
  await trigger.click();
  await light.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(trigger).toHaveText("Light 2026");
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(light).toBeFocused();
  await expect(list).toHaveCSS("background-color", "rgb(250, 250, 253)");
  await page.keyboard.press("ArrowUp");
  await expect(dark).toBeFocused();
  await expect(dark).toHaveCSS("color", "rgb(32, 32, 32)");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Light 2026");

  await trigger.press("Enter");
  await expect(light).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(dark).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(trigger).toHaveText("Dark 2026");

  await trigger.click();
  await expect(dark).toBeFocused();
  await page.locator(".settings-dialog-title").click();
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
});

test("settings combobox keeps long model names within a narrow workbench", async ({ page }) => {
  const longModel = {
    id: "long-model",
    name: "Documentation and release review model with a descriptive name that exceeds the available Settings column",
    provider: "fixture",
  };
  let catalog: (typeof longModel)[] = [];
  await page.routeWebSocket("**/api/transport/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "request" && frame.path === "/rpc/chat.listModels") {
        socket.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: catalog }));
      } else {
        server.send(raw);
      }
    });
  });
  await page.setViewportSize({ width: 430, height: 760 });
  await page.goto("/");
  await openSettingsInEditor(page);

  const model = page.getByRole("combobox", { name: "Default model", exact: true });
  await expect(model).toBeDisabled();
  await expect(model).toHaveText("No options available");

  catalog = [{ ...longModel, id: "", name: "Standard model" }, longModel];
  await page.reload();
  await openSettingsInEditor(page);
  const sidebar = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
  if ((await sidebar.getAttribute("aria-pressed")) !== "true") await sidebar.click();
  await expect(model).toHaveText("Standard model");
  await model.click();
  const list = page.getByRole("listbox", { name: "Default model", exact: true });
  const option = list.getByRole("option", { name: longModel.name, exact: true });
  await expect(list).toBeInViewport({ ratio: 1 });
  await expect(option).toBeInViewport({ ratio: 1 });
  await option.click();
  await expect(model).toHaveText(longModel.name);

  for (const name of ["Color theme", "Default model", "Primary sidebar", "Activity Bar Position"]) {
    const trigger = page.getByRole("combobox", { name, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        trigger.evaluate((el) => {
          const control = el.getBoundingClientRect();
          const row = el.closest(".setting")!;
          const setting = row.getBoundingClientRect();
          const description = row.querySelector(":scope > span")!.getBoundingClientRect();
          return (
            control.left >= setting.left &&
            control.right <= setting.right &&
            control.top >= description.bottom
          );
        }),
      )
      .toBe(true);
  }

  await page.reload();
  await openSettingsInEditor(page);
  await expect(model).toHaveText(longModel.name);
  await model.click();
  await list.getByRole("option", { name: "Standard model", exact: true }).click();
  await expect(model).toHaveText("Standard model");
});
