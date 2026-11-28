import { expect, test } from "@playwright/test";

test("VS Code editor events follow real Monaco registration, selection and removal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/vscode-empty.fixture.html");
  const result = await page.evaluate(async (moduleUrl) => {
    const fixture = await import(moduleUrl);
    return fixture.observeEditorEvents();
  }, "/tests/vscode-editor-events.fixture.ts");
  expect(result.visible).toEqual([1, 0]);
  expect(result.selections).toEqual([
    { active: [1, 3], kind: 3 },
    { active: [0, 1], kind: 3 },
    { active: [1, 0], kind: 3 },
    { active: [0, 0], kind: undefined },
  ]);
  expect(result.visibleRanges.some((line: number) => line > 0)).toBe(true);
  expect(errors).toEqual([]);
});
