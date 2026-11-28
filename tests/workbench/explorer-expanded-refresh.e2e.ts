import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("Explorer refresh updates expanded directories when file events are missing", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("explorer-refresh");
  const nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "before.txt"), "original");

  await page.goto("/tests/explorer-expanded-refresh.fixture.html");
  await page.evaluate(
    async (root) =>
      (await import("/tests/explorer-expanded-refresh.fixture.ts")).mountExplorer(root),
    root,
  );

  const explorer = page.getByRole("tree", { name: "Explorer", exact: true });
  await explorer.getByRole("treeitem", { name: "nested", exact: true }).click();
  await expect(explorer.getByRole("treeitem", { name: /^before\.txt/ })).toBeVisible();

  await writeFile(join(root, "top-level.txt"), "added at the root");
  await writeFile(join(nested, "after.txt"), "added in the expanded directory");
  const after = explorer.getByRole("treeitem", { name: /^after\.txt/ });
  await expect(after).toHaveCount(0);
  await page
    .locator(".files-toolbar")
    .getByRole("button", { name: "Refresh Explorer", exact: true })
    .click();

  await expect(explorer.getByRole("treeitem", { name: /^top-level\.txt/ })).toBeVisible();
  await expect(after).toBeVisible();
});

test("Explorer fits tall and short panels and scrolls to the last file", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("explorer-long-list");
  await mkdir(root, { recursive: true });
  await Promise.all(
    Array.from({ length: 54 }, (_, i) => {
      const name = `entry-${String(i).padStart(2, "0")}.txt`;
      return writeFile(join(root, name), name);
    }),
  );

  await page.goto("/tests/explorer-expanded-refresh.fixture.html");
  await page.evaluate(
    async (root) =>
      (await import("/tests/explorer-expanded-refresh.fixture.ts")).mountExplorer(root),
    root,
  );

  const explorer = page.getByRole("tree", { name: "Explorer", exact: true });
  const first = explorer.getByRole("treeitem", { name: /^entry-00\.txt\b/ });
  const last = explorer.getByRole("treeitem", { name: /^entry-53\.txt\b/ });

  for (const height of [900, 360]) {
    await page.setViewportSize({ width: 900, height });
    await expect
      .poll(async () => {
        const box = await explorer.boundingBox();
        return box && Math.round(box.y + box.height);
      })
      .toBe(height);
    await expect(first).toBeInViewport({ ratio: 0.99 });
    await explorer.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("PageDown");
    await expect(last).toBeInViewport({ ratio: 0.99 });
    for (let i = 0; i < 5; i++) await page.keyboard.press("PageUp");
    await expect(first).toBeInViewport({ ratio: 0.99 });
  }
});
