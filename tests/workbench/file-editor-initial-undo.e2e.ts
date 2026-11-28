import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

for (const { name, original, initiallyMissing } of [
  { name: "a nonempty file", original: "original" },
  { name: "an empty file", original: "" },
  { name: "a file loaded after a read error", original: "original", initiallyMissing: true },
]) {
  test(`undo preserves the initial disk content of ${name}`, async ({ page }) => {
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(join(artifacts, "file-editor-initial-undo-"));
    try {
      const file = join(root, "sample.txt");
      if (!initiallyMissing) await writeFile(file, original);
      await page.goto("/tests/file-editor-initial-undo.fixture.html");
      await page.evaluate(
        async (root) => (await import("/tests/file-editor-initial-undo.fixture.ts")).openFile(root),
        root,
      );
      if (initiallyMissing) {
        await expect(page.locator(".file-editor-placeholder.is-error")).toBeVisible();
        await writeFile(file, original);
        await page.evaluate(
          async (root) =>
            (await import("/tests/file-editor-initial-undo.fixture.ts")).reloadFile(root),
          root,
        );
      }
      const line = page.locator(".file-editor-monaco .view-line");
      const dirty = page.getByText("Unsaved changes", { exact: true });
      await expect(line).toBeVisible();
      await expect(line).toHaveText(original);
      await line.click();
      await page.keyboard.press("ControlOrMeta+z");
      await expect(line).toHaveText(original);
      await expect(dirty).toHaveCount(0);

      await page.keyboard.press("End");
      await page.keyboard.insertText("!");
      await expect(line).toHaveText(original + "!");
      await expect(dirty).toBeVisible();
      await page.keyboard.press("ControlOrMeta+z");
      await expect(line).toHaveText(original);
      await expect(dirty).toHaveCount(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
