import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("official builtin languages drive embedded editing, secondary languages, snippets and templates in FileEditorView", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const builtins =
    process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
    process.env.HARNESS_VSCODE_BUILTINS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(
    !existsSync(join(builtins, "markdown-math/package.json")),
    "Requires official installed VS Code builtins",
  );
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "builtin-languages-"));
  const fixtures = {
    "race.ts": "const startup = 1;\n",
    "math.md": "$$\nx + y\n$$\n",
    "inline.md": "before $x + y$ after\n",
    "fenced.md": "```math\nx + y\n```\n",
    "view.tsx": "const View = () => <div>{value}</div>;\n",
    ".eslintrc.json": '{\n  // comment allowed by JSONC\n  "rules": {}\n}\n',
    script: "#!/usr/bin/env python\nprint('hello')\n",
    "snippet.ts": "",
    "method.ts": "",
    "document.html": "replace this file",
    "embedded.html": "<script>\nconst value = 1;\n</script>\n",
    "indent.html": "<DIV></DIV>",
  };
  for (const [name, content] of Object.entries(fixtures)) writeFileSync(join(root, name), content);
  const browserErrors = await captureBrowserErrors(page);
  let grammarUrl = "";
  let releaseGrammar!: () => void;
  const grammarGate = new Promise<void>((resolve) => {
    releaseGrammar = resolve;
  });
  await page.route(
    /\/(?:typescript-[^/]+\.js|basic-languages\/typescript\/typescript\.js)(?:\?|$)/,
    async (route) => {
      grammarUrl ||= route.request().url();
      await grammarGate;
      await route.continue();
    },
  );
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  const open = async (name: string) => {
    await page.evaluate(
      async (path) =>
        (await import("/tests/vscode-builtin-languages.fixture.ts")).openDocument(path),
      join(root, name),
    );
    await expect(page.locator(".file-editor-view .monaco-editor.focused")).toBeVisible();
  };
  await page.evaluate(
    async (root) =>
      (await import("/tests/vscode-builtin-languages.fixture.ts")).openWorkspace(root),
    root,
  );
  await open("race.ts");
  await expect.poll(() => grammarUrl).not.toBe("");
  const prepared = await page.evaluate(
    async ({ builtins, root }) =>
      (await import("/tests/vscode-builtin-languages.fixture.ts")).prepareContributions(
        builtins,
        root,
      ),
    { builtins, root },
  );
  const observations: Record<string, unknown> = { prepared };
  releaseGrammar();
  await page.evaluate(async (url) => {
    await import(url);
  }, grammarUrl);
  const state = (line = 1, column = 1) =>
    page.evaluate(
      async ({ line, column }) =>
        (await import("/tests/vscode-builtin-languages.fixture.ts")).editorState(line, column),
      { line, column },
    );
  const position = (line: number, column: number) =>
    page.evaluate(
      async ({ line, column }) =>
        (await import("/tests/vscode-builtin-languages.fixture.ts")).position(line, column),
      { line, column },
    );
  try {
    expect(prepared.issues).toEqual([]);
    observations.delayedDefaultGrammar = await state();
    expect
      .soft(
        (observations.delayedDefaultGrammar as any).scopes.some((scope: string) =>
          scope.includes("source.ts "),
        ),
      )
      .toBe(true);
    expect((await state()).lineTokenCount).toBeGreaterThan(1);
    const setLineLimit = (limit?: number) =>
      page.evaluate(
        async (value) =>
          (
            await import("/tests/vscode-builtin-languages.fixture.ts")
          ).setTypeScriptTokenizationLineLimit(value),
        limit,
      );
    await setLineLimit(10);
    try {
      await expect.poll(async () => (await state()).lineTokenCount).toBe(1);
      expect((await state()).scopes).toEqual([""]);
    } finally {
      await setLineLimit();
    }
    await expect.poll(async () => (await state()).lineTokenCount).toBeGreaterThan(1);
    await open("math.md");
    await position(2, 6);
    observations.mathBefore = await state(2, 3);
    expect
      .soft(observations.mathBefore)
      .toMatchObject({ language: "markdown", embeddedLanguage: "latex" });
    await page.keyboard.press("ControlOrMeta+/");
    observations.mathAfter = await state(2, 3);
    expect.soft((observations.mathAfter as any).text).toBe("$$\n% x + y\n$$\n");
    for (const [name, line, column] of [
      ["inline.md", 1, 10],
      ["fenced.md", 2, 3],
    ] as const) {
      await open(name);
      observations[name] = await state(line, column);
      expect
        .soft(observations[name])
        .toMatchObject({ language: "markdown", embeddedLanguage: "latex" });
    }

    for (const [name, language] of [
      ["view.tsx", "typescriptreact"],
      [".eslintrc.json", "jsonc"],
      ["script", "python"],
    ]) {
      await open(name!);
      const current = await state();
      observations[name!] = current;
      expect.soft(current.language, name).toBe(language);
      expect
        .soft(
          current.scopes.some((scope) => scope.includes(" ")),
          name,
        )
        .toBe(true);
    }
    await page.locator(".dv-tab").filter({ hasText: "view.tsx" }).click();
    await page.locator(".file-editor-view .monaco-editor").filter({ visible: true }).click();
    observations.jsxTag = await state(1, 21);
    observations.jsxExpression = await state(1, 27);
    expect.soft(observations.jsxTag).toMatchObject({ embeddedLanguage: "jsx-tags" });
    expect.soft(observations.jsxExpression).toMatchObject({ embeddedLanguage: "typescriptreact" });

    await open("snippet.ts");
    await page.keyboard.type("forof", { delay: 50 });
    await page.keyboard.press("Control+Space");
    await expect(page.locator(".suggest-widget.visible")).toBeVisible();
    const snippet = page
      .locator(".suggest-widget .monaco-list-row")
      .filter({ hasText: "For-Of Loop" })
      .first();
    await expect(snippet).toBeVisible();
    await snippet.click();
    await expect(page.locator(".suggest-widget.visible")).toBeHidden();
    await expect.poll(state).toMatchObject({ selectedText: "element" });
    observations.snippet = await state();
    expect.soft(observations.snippet).toMatchObject({ selectedText: "element" });
    expect.soft((observations.snippet as any).text).toContain("for (const element of object)");
    await page.keyboard.type("item");
    await page.keyboard.press("Tab");
    await page.keyboard.type("items");
    observations.snippetEdited = await state();
    expect
      .soft(
        (observations.snippetEdited as any).scopes.some((scope: string) =>
          scope.includes("source.ts "),
        ),
      )
      .toBe(true);
    await page.evaluate(async () =>
      (await import("/tests/vscode-builtin-languages.fixture.ts")).refreshContributions(),
    );
    observations.snippetAfterRefresh = await state();
    expect
      .soft((observations.snippetAfterRefresh as any).text)
      .toBe((observations.snippetEdited as any).text);
    expect.soft((observations.snippetEdited as any).text).toContain("for (const item of items)");

    await open("method.ts");
    await page.keyboard.type("public method", { delay: 50 });
    await page.keyboard.press("Control+Space");
    await page
      .locator(".suggest-widget .monaco-list-row")
      .filter({ hasText: "Public Method Definition" })
      .first()
      .click();
    await expect.poll(state).toMatchObject({ selectedText: "name" });
    await page.keyboard.type("calculate");
    observations.multipleWordPrefix = await state();
    expect.soft((observations.multipleWordPrefix as any).text).toContain(" * calculate");
    expect.soft((observations.multipleWordPrefix as any).text).toContain("public calculate()");
    expect.soft((observations.multipleWordPrefix as any).text).not.toContain("public method");

    await open("document.html");
    await page
      .locator(".file-editor-view .monaco-editor.focused .view-lines")
      .click({ button: "right" });
    // Monaco delays menu mouseup handlers by 100ms to reject accidental clicks.
    await page.getByText("Fill File: HTML Document", { exact: true }).click({ delay: 150 });
    await expect.poll(state).toMatchObject({ selectedText: "title" });
    observations.template = await state();
    expect.soft((observations.template as any).text).toContain("<!DOCTYPE html>");
    expect.soft(observations.template).toMatchObject({ selectedText: "title" });
    await page.keyboard.type("Builtin Template");
    await page.keyboard.press("Tab");
    observations.templateEdited = await state();
    expect
      .soft((observations.templateEdited as any).text)
      .toContain("<title>Builtin Template</title>");
    await page.screenshot({ path: join(root, "file-editor.png") });

    await open("embedded.html");
    await position(2, 6);
    observations.embeddedHtml = await state(2, 6);
    expect.soft(observations.embeddedHtml).toMatchObject({ embeddedLanguage: "javascript" });
    await page.keyboard.press("ControlOrMeta+/");
    observations.embeddedHtmlComment = await state(2, 6);
    expect.soft((observations.embeddedHtmlComment as any).text).toContain("// const value = 1;");

    await open("indent.html");
    await position(1, 6);
    await page.keyboard.press("Enter");
    observations.htmlIndent = await state();
    expect.soft((observations.htmlIndent as any).text).toBe("<DIV>\n  \n</DIV>");
  } finally {
    observations.browserErrors = await browserErrors();
    writeFileSync(join(root, "report.json"), JSON.stringify(observations, null, 2) + "\n");
  }
  expect(observations.browserErrors).toEqual([]);
});
