import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("workbench shortcuts leave IME composition and its focus untouched", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.fill("正在输入");
  const cancelled = await composer.evaluate((input) =>
    ["k", ",", "b", "`"].map(
      (key) =>
        !input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey: true,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
  );
  expect(cancelled).toEqual([false, false, false, false]);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("正在输入");
  await expect(page.getByRole("tree", { name: "Conversations", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search commands", exact: true })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeHidden();
});

test("hiding a focused sidebar restores the composer while pointer toggles keep their focus", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.fill("keep this draft");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.focus();
  await tree.press("ControlOrMeta+b");
  await expect(tree).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("keep this draft");

  const toggle = page.getByRole("button", { name: "Toggle primary sidebar", exact: true });
  await toggle.click();
  await expect(tree).toBeVisible();
  await tree.focus();
  await toggle.click();
  await expect(tree).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("hiding a sidebar from its context menu restores the editor after the menu closes", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.fill("menu focus draft");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  await tree.focus();
  const heading = (await page
    .getByRole("heading", { name: "Conversations", exact: true })
    .boundingBox())!;
  await page.mouse.click(heading.x + 10, heading.y + heading.height / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Hide primary sidebar", exact: true }).click();
  await expect(tree).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("menu focus draft");
});

test("hiding a focused terminal returns to the existing file editor and preserves its caret", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("focus-workspace");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "focus.txt"), "keep-editor");
  const terminal = {
    id: "focus-shell",
    title: "Focus shell",
    cwd: root,
    pid: 1,
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  };
  await page.route("**/api/terminals", (route) => route.fulfill({ json: [terminal] }));
  await page.routeWebSocket("**/ws/terminals/*", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", info: terminal, data: "Terminal ready\r\n" }));
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const workspace = await page.evaluate(
    async (root) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
    root,
  );
  try {
    await page
      .getByRole("tree", { name: "Explorer", exact: true })
      .getByRole("treeitem", { name: "focus.txt", exact: true })
      .click();
    const editor = page.locator(".file-editor-monaco:visible .monaco-editor");
    await expect(editor.locator(".view-lines")).toHaveText("keep-editor");
    const input = editor.getByRole("textbox");
    await input.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
    const terminalInput = page.locator(".xterm-helper-textarea:visible");
    await terminalInput.focus();
    await terminalInput.press("ControlOrMeta+`");
    await expect(
      page.getByRole("button", { name: "Toggle bottom panel", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toBeHidden();
    await expect(input).toBeFocused();
    await expect(page.getByRole("tab", { name: "focus.txt", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.insertText("!");
    await expect(editor.locator(".view-lines")).toHaveText("k!eep-editor");
  } finally {
    await page.evaluate(
      async (workspace) =>
        (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace),
      workspace,
    );
  }
});

test("closing an editor tab returns focus to its remaining editor", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.fill("tab closing draft");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  const close = page.getByRole("button", { name: "Close Settings", exact: true });
  await close.focus();
  await close.press("Enter");
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("tab closing draft");

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await composer.focus();
  await composer.press("Home");
  await composer.press("ArrowRight");
  await page.getByRole("tab", { name: "Settings", exact: true }).click({ button: "middle" });
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await page.keyboard.insertText("!");
  await expect(composer).toHaveValue("t!ab closing draft");

  await page.getByRole("button", { name: "Close Chat", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement !== document.body &&
          Boolean(document.activeElement?.closest(".dv-content-container")),
      ),
    )
    .toBe(true);
});

test("closing the last editor with the sidebars hidden focuses the existing empty workbench action", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle primary sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Toggle workspace panel", exact: true }).click();
  await page.getByRole("button", { name: "Close Chat", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open chat", exact: true })).toBeFocused();
});
