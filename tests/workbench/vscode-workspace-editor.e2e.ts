import { expect, test } from "@playwright/test";

test("VS Code workspace edits stay dirty and real editors preserve undo, EOL and decoration lifetime", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const result = await page.evaluate(async (moduleUrl) => {
    const fixture = await import(moduleUrl);
    return fixture.observeWorkspaceEditorSemantics();
  }, "/tests/vscode-workspace-editor.fixture.ts");
  expect(result).toMatchObject({
    same: true,
    applied: true,
    afterWorkspaceEdit: { text: "aB\r\ncd\r\n", saved: "ab\r\ncd\r\n", dirty: true },
    overlapping: false,
    partial: false,
    beforeShow: "aB\r\ncd\r\n",
    tabOpens: 1,
    selection: [1, 2],
    editorApplied: true,
    afterEditorEdit: "prefix aB\ncd\n",
    afterUndo: "aB\r\ncd\r\n",
    builderRejected: true,
    decorationBefore: { count: 1, wholeLine: true, hover: { value: "hover text" } },
    decorationAfter: 0,
    savedSuccessfully: true,
    closed: true,
  });
  expect(result.events).toEqual([
    "open",
    "change:1",
    "change:1",
    "change:1",
    "change:0",
    "save",
    "close",
  ]);
  expect(errors).toEqual([]);
});
