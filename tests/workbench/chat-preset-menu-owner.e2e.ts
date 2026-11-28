import { expect, test } from "@playwright/test";

test("the agent preset popup closes when the selected conversation changes", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");

  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  const preset = page.getByRole("button", { name: "Select agent preset", exact: true });
  const popup = page.getByRole("listbox", { name: "Agent presets", exact: true });
  await composer.fill("Draft in the original conversation");
  await preset.press("Enter");
  await expect(popup).toBeVisible();
  await expect(preset).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("ControlOrMeta+n");
  await expect(composer).toHaveValue("");
  await expect(popup).toHaveCount(0);
  await expect(preset).toHaveAttribute("aria-expanded", "false");
  await composer.click();
  await expect(composer).toBeFocused();

  await preset.click();
  await expect(popup).toBeVisible();
  await expect(preset).toHaveAttribute("aria-expanded", "true");
});
