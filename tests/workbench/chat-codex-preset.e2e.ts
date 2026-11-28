import { expect, test } from "@playwright/test";

test("Codex shows its icon and description in the preset menu and active conversation", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");

  const trigger = page.getByRole("button", { name: "Select agent preset", exact: true });
  await trigger.click();
  const codex = page.getByRole("menuitemradio", { name: "Codex", exact: true });
  const description = "Codex-style coding assistant for editing files and running commands";
  const menuIcon = codex.locator(".agent-preset-icon");
  await expect(menuIcon).toBeVisible();
  await expect(menuIcon).toHaveCSS("mask-image", /data:image\/svg\+xml/);
  const mask = await menuIcon.evaluate((element) => getComputedStyle(element).maskImage);
  await expect(codex.locator(".i-codicon-sparkle")).toHaveCount(0);
  await expect(codex.locator(".preset-description")).toHaveText(description);
  await expect(codex).toHaveAccessibleDescription(description);
  await codex.click();
  await expect(trigger).toContainText("Codex");
  await expect(trigger.locator(".agent-preset-icon")).toBeVisible();
  await expect(trigger.locator(".agent-preset-icon")).toHaveCSS("mask-image", mask);

  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.fill("Check the Codex preset presentation");
  await composer.press("Enter");
  const activeIcon = page.getByRole("img", { name: "Agent preset: Codex", exact: true });
  try {
    await expect(trigger).toHaveCount(0);
    await expect(activeIcon.locator(".agent-preset-icon")).toBeVisible();
    await expect(activeIcon.locator(".agent-preset-icon")).toHaveCSS("mask-image", mask);
    await activeIcon.focus();
    const hover = page.locator(".preset-hover").filter({ visible: true });
    await expect(hover.locator(".agent-preset-icon")).toBeVisible();
    await expect(hover.locator(".agent-preset-icon")).toHaveCSS("mask-image", mask);
    await expect(hover.locator(".preset-name")).toHaveText("Codex");
    await expect(hover.locator(".preset-description")).toHaveText(description);
  } finally {
    await page.getByRole("button", { name: "Stop response", exact: true }).click();
  }
});
