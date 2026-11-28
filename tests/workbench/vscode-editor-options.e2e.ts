import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("extension editor options persist across snapshots and receive Monaco changes", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-editor-options-"));
  try {
    const workspace = join(root, "workspace");
    const extensions = join(root, "extensions");
    const extension = join(extensions, "options-fixture");
    const file = join(workspace, "indent.ts");
    mkdirSync(workspace);
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      file,
      [
        "function demo() {",
        "  const a = 1;",
        "  const b = 2;",
        "  if (a) {",
        "    return a + b;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "options-fixture",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:editorOptionsFixture.open"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  let editor;
  let live;
  let lastEvent;
  function register(id, run) {
    subscriptions.push(vscode.commands.registerCommand("editorOptionsFixture." + id, run));
  }
  subscriptions.push(vscode.window.onDidChangeTextEditorOptions((event) => {
    if (event.textEditor.document.uri.toString() === editor?.document.uri.toString()) {
      lastEvent = { sameEditor: event.textEditor === editor, options: event.options };
    }
  }));
  register("open", async (file) => {
    editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    live = editor.options;
  });
  register("tabSize", () => {
    live.tabSize = "6";
    const written = live.tabSize;
    live.tabSize = -1;
    return { written, unchanged: live.tabSize, sameOptions: live === editor.options };
  });
  register("assign", () => {
    editor.options = {
      indentSize: 3,
      insertSpaces: "false",
      cursorStyle: vscode.TextEditorCursorStyle.BlockOutline,
      lineNumbers: vscode.TextEditorLineNumbersStyle.Relative,
    };
  });
  register("link", () => { editor.options = { tabSize: 5, indentSize: "tabSize" }; });
  register("auto", () => { editor.options = { tabSize: "auto", insertSpaces: "auto" }; });
  register("state", () => ({ sameOptions: live === editor.options, options: { ...live }, lastEvent }));
};
`,
    );

    await page.goto("/");
    await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
    await page.evaluate(
      async ({ workspace, extensions }) =>
        (await import("/tests/vscode-virtual-workbench.fixture.ts")).scanAndOpen(
          workspace,
          extensions,
        ),
      { workspace, extensions },
    );
    const currentHost = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-virtual-workbench.fixture.ts")).activeHost(),
      );
    await expect.poll(currentHost).toBeTruthy();
    const sessionId = (await currentHost())!;
    const execute = (id: string, ...args: unknown[]) =>
      page.evaluate(
        async ({ sessionId, id, args }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            "editorOptionsFixture." + id,
            args,
          ),
        { sessionId, id, args },
      );
    const browserOptions = (update?: {
      tabSize: number;
      indentSize: number;
      insertSpaces: boolean;
    }) =>
      page.evaluate(
        async ({ file, update }) =>
          (await import("/tests/vscode-editor-options.fixture.ts")).editorOptions(file, update),
        { file, update },
      );

    await execute("open", file);
    expect(await execute("tabSize")).toEqual({ written: 6, unchanged: 6, sameOptions: true });
    await expect.poll(() => browserOptions()).toMatchObject({ tabSize: 6 });
    await execute("assign");
    const assigned = {
      tabSize: 6,
      indentSize: 3,
      insertSpaces: false,
      cursorStyle: 5,
      lineNumbers: 2,
    };
    await expect.poll(() => browserOptions()).toEqual(assigned);
    await expect
      .poll(() => execute("state"))
      .toMatchObject({
        sameOptions: true,
        options: assigned,
        lastEvent: { sameEditor: true, options: assigned },
      });

    const changed = {
      tabSize: 8,
      indentSize: 2,
      insertSpaces: true,
      cursorStyle: 5,
      lineNumbers: 2,
    };
    expect(await browserOptions({ tabSize: 8, indentSize: 2, insertSpaces: true })).toEqual(
      changed,
    );
    await expect
      .poll(() => execute("state"))
      .toMatchObject({
        sameOptions: true,
        options: changed,
        lastEvent: { sameEditor: true, options: changed },
      });

    await execute("link");
    await expect.poll(() => browserOptions()).toMatchObject({ tabSize: 5, indentSize: 5 });
    await execute("auto");
    await expect
      .poll(() => browserOptions())
      .toMatchObject({ tabSize: 2, indentSize: 2, insertSpaces: true });
    await expect
      .poll(() => execute("state"))
      .toMatchObject({
        lastEvent: { sameEditor: true, options: { tabSize: 2, indentSize: 2, insertSpaces: true } },
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
