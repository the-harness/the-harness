import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("showTextDocument reveals an existing background tab and its requested selection", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "reopen-editor-"));
  writeFileSync(
    join(root, "main.tsx"),
    Array.from({ length: 220 }, (_, index) =>
      index === 179 ? 'const reopenedTarget = "selected";' : `const line${index} = ${index};`,
    ).join("\n"),
  );
  writeFileSync(join(root, "other.py"), 'print("other editor")\n');
  const errors = await captureBrowserErrors(page);
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  await page.evaluate(
    async (root) =>
      (await import("/tests/vscode-reopen-editor.fixture.ts")).preview(root, "main.tsx"),
    root,
  );
  await expect(page.getByRole("tab", { name: "main.tsx", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(async () =>
            (await import("/tests/vscode-reopen-editor.fixture.ts")).snapshot(),
          )
        ).previewPath,
    )
    .toBe(join(root, "main.tsx"));
  await page.evaluate(
    async (root) => (await import("/tests/vscode-reopen-editor.fixture.ts")).show(root, "other.py"),
    root,
  );
  await expect(page.getByRole("tab", { name: "other.py", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.evaluate(
    async (root) =>
      (await import("/tests/vscode-reopen-editor.fixture.ts")).show(
        root,
        "main.tsx",
        [179, 6, 179, 20],
      ),
    root,
  );
  const reopened = await page.evaluate(async () =>
    (await import("/tests/vscode-reopen-editor.fixture.ts")).snapshot(),
  );
  writeFileSync(join(root, "reopened.json"), JSON.stringify(reopened, null, 2));
  await expect(page.getByRole("tab", { name: "main.tsx", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "main.tsx", exact: true })).toHaveCount(1);
  expect(reopened).toMatchObject({
    previewPath: null,
    activePath: join(root, "main.tsx"),
    selected: expect.arrayContaining(["main.tsx"]),
    target: { selectedText: "reopenedTarget", focused: true },
  });
  await expect
    .poll(async () =>
      (
        await page.evaluate(async () =>
          (await import("/tests/vscode-reopen-editor.fixture.ts")).snapshot(),
        )
      ).target.visibleRanges.some(
        (range: { start: number; end: number }) => range.start <= 179 && range.end >= 179,
      ),
    )
    .toBe(true);
  await page.evaluate(
    async (root) => (await import("/tests/vscode-reopen-editor.fixture.ts")).show(root, "other.py"),
    root,
  );
  const search = page.getByRole("button", { name: "Open command palette", exact: true });
  await search.focus();
  await page.evaluate(
    async (root) =>
      (await import("/tests/vscode-reopen-editor.fixture.ts")).show(
        root,
        "main.tsx",
        [179, 6, 179, 20],
        true,
      ),
    root,
  );
  await expect(page.getByRole("tab", { name: "main.tsx", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(search).toBeFocused();
  await page.screenshot({ path: join(root, "reopened.png") });
  expect(await errors()).toEqual([]);
});
