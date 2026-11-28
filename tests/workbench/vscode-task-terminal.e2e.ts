import { expect, test } from "@playwright/test";

test("task output and exit arrive through the real terminal socket without mounting a terminal panel", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const events = await page.evaluate(async () => {
    const fixture = await import("/tests/vscode-task-terminal.fixture.ts");
    return await fixture.observeTaskWithoutTerminalPanel();
  });
  expect(events[0]).toEqual(["start", true]);
  expect(events.at(-1)).toEqual(["end", 7]);
  expect(JSON.stringify(events)).toContain("TASK_WITHOUT_PANEL_OK");
  expect(errors).toEqual([]);
});
