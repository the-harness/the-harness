import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

async function keycaps(page: Page) {
  return page.getByRole("listbox").evaluate((list) => {
    const foreground = getComputedStyle(list).color;
    const keys = [...list.querySelectorAll<HTMLElement>(".command-key")].map((key) => {
      const style = getComputedStyle(key);
      const row = key.closest('[role="option"]')!;
      const bounds = key.getBoundingClientRect();
      return {
        text: key.textContent,
        width: bounds.width,
        height: bounds.height,
        right: bounds.right,
        color: style.color,
        background: style.backgroundColor,
        border: style.borderColor,
        rowColor: getComputedStyle(row).color,
        selected: row.getAttribute("aria-selected") === "true",
        clipped: key.scrollWidth > key.clientWidth,
      };
    });
    return { foreground, keys };
  });
}

for (const platform of ["MacIntel", "Linux x86_64"]) {
  for (const theme of ["dark", "light"]) {
    test(`command keycaps keep their colors and alignment after opening an editor on ${platform} in ${theme}`, async ({ page }, testInfo) => {
      const errors = await captureBrowserErrors(page);
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", { get: () => platform });
      }, platform);
      const root = testInfo.outputPath("keycap-workspace");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "notes.txt"), "Keycap regression");
      await page.goto("/");
      if (theme === "light") {
        await page.getByRole("button", { name: "Manage", exact: true }).click();
        await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await page.getByRole("combobox", { name: "Color theme", exact: true }).click();
        await page.getByRole("option", { name: "Light 2026", exact: true }).click();
        await page.keyboard.press("Escape");
      }
      const trigger = page.getByRole("button", { name: "Open command palette", exact: true });
      await trigger.click();
      const input = page.getByRole("combobox", { name: "Search commands", exact: true });
      await expect(input).toBeFocused();
      const before = await keycaps(page);
      expect(before.keys.length).toBeGreaterThanOrEqual(8);
      for (const key of before.keys) {
        expect(key.color).toBe(key.selected ? key.rowColor : before.foreground);
        expect(key.height).toBe(18);
        expect(key.clipped).toBe(false);
      }
      expect(new Set(before.keys.filter((key) => key.text?.length === 1).map((key) => key.width))).toEqual(new Set([22]));
      if (platform === "Linux x86_64") {
        expect(before.keys.find((key) => key.text === "Ctrl")!.width).toBeGreaterThan(22);
      }
      const finalKeys = before.keys.filter((key) => ["N", ",", "B", "`"].includes(key.text ?? ""));
      expect(new Set(finalKeys.map((key) => key.right)).size).toBe(1);
      await input.press("Escape");
      const workspace = await page.evaluate(async (root) =>
        (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root), root);
      try {
        await page.getByRole("treeitem", { name: "notes.txt", exact: true }).click();
        await expect(page.locator(".file-editor-monaco:visible .view-lines")).toHaveText("Keycap regression");
        await trigger.click();
        await expect(input).toBeFocused();
        expect(await keycaps(page)).toEqual(before);
        const settings = page.getByRole("option", { name: /^Open Settings/ });
        await settings.hover();
        await expect(settings).toHaveAttribute("aria-selected", "true");
        const hovered = await keycaps(page);
        for (const key of hovered.keys.filter((key) => key.selected)) {
          expect(key.color).toBe(key.rowColor);
          expect(key.background).toBe("rgba(0, 0, 0, 0)");
        }
        await input.press("ArrowDown");
        await expect(page.getByRole("option", { name: /^Layout: Toggle primary sidebar/ })).toHaveAttribute("aria-selected", "true");
        const navigated = await keycaps(page);
        expect(navigated.keys.map(({ width, height, right }) => [width, height, right]))
          .toEqual(before.keys.map(({ width, height, right }) => [width, height, right]));
        expect(await errors()).toEqual([]);
      } finally {
        await page.keyboard.press("Escape");
        await page.evaluate(async (workspace) =>
          (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace), workspace);
      }
    });
  }
}
