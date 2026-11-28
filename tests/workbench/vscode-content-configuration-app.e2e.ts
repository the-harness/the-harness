import { expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("normal App applies extension defaults to keyboard editing and real filesystem saves", async ({
  page,
}) => {
  const builtins =
    process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
    process.env.HARNESS_VSCODE_BUILTINS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(!existsSync(join(builtins, "go/package.json")), "Requires official content extensions");
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "configuration-app-"));
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  for (const name of ["go", "make", "prompt-basics", "shellscript"])
    cpSync(join(builtins, name), join(extensions, name), { recursive: true });
  for (const name of ["main.go", "Makefile"]) writeFileSync(join(root, name), "");
  writeFileSync(join(root, "review.prompt.md"), "A long prompt line. ".repeat(60));
  writeFileSync(join(root, "save.sh"), "echo first\r\necho second\r\n");
  const errors = await captureBrowserErrors(page);
  await page.goto("/");
  await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
  await page.evaluate(
    async ({ extensions, root }) =>
      (await import("/tests/vscode-content-configuration-app.fixture.ts")).load(extensions, root),
    { extensions, root },
  );
  const snapshot = (path: string) =>
    page.evaluate(
      async (path) =>
        (await import("/tests/vscode-content-configuration-app.fixture.ts")).snapshot(path),
      path,
    );
  const report: Record<string, unknown> = {};
  for (const [name, language] of [
    ["main.go", "go"],
    ["Makefile", "makefile"],
  ]) {
    const path = join(root, name!);
    await page.evaluate(
      async (path) =>
        (await import("/tests/vscode-content-configuration-app.fixture.ts")).open(path),
      path,
    );
    await expect.poll(() => snapshot(path)).toMatchObject({ language, insertSpaces: false });
    await page.getByRole("textbox", { name: "Editor content" }).press("Tab");
    await expect.poll(() => snapshot(path)).toMatchObject({ text: "\t", dirty: true });
    report[name!] = await snapshot(path);
    if (language === "go") {
      await page.evaluate(async () =>
        (await import("/tests/vscode-content-configuration-app.fixture.ts")).overrideGo(),
      );
      await expect.poll(() => snapshot(path)).toMatchObject({ insertSpaces: true, tabSize: 4 });
      const input = page.getByRole("textbox", { name: "Editor content" });
      await input.press("ControlOrMeta+a");
      await input.press("Backspace");
      await input.press("Tab");
      await expect.poll(() => snapshot(path)).toMatchObject({ text: "    ", dirty: true });
      report.goOverride = await snapshot(path);
    }
  }
  const prompt = join(root, "review.prompt.md");
  await page.evaluate(
    async (path) => (await import("/tests/vscode-content-configuration-app.fixture.ts")).open(path),
    prompt,
  );
  await expect
    .poll(() => snapshot(prompt))
    .toMatchObject({ language: "prompt", wordWrap: "on", wrapping: { isViewportWrapping: true } });
  report.prompt = await snapshot(prompt);
  const shell = join(root, "save.sh");
  await page.evaluate(
    async (path) => (await import("/tests/vscode-content-configuration-app.fixture.ts")).open(path),
    shell,
  );
  await expect.poll(() => snapshot(shell)).toMatchObject({ language: "shellscript" });
  expect(readFileSync(shell, "utf8")).toContain("\r\n");
  const input = page.getByRole("textbox", { name: "Editor content" });
  const documentEnd = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
  await input.press(documentEnd);
  await input.pressSequentially("echo third");
  await input.press("ControlOrMeta+s");
  const expected = "echo first\necho second\necho third";
  await expect.poll(() => readFileSync(shell, "utf8")).toBe(expected);
  await expect
    .poll(() => snapshot(shell))
    .toMatchObject({ text: expected, savedContent: expected, dirty: false });
  report.savedLf = { editor: await snapshot(shell), disk: readFileSync(shell, "utf8") };
  await page.evaluate(async () =>
    (await import("/tests/vscode-content-configuration-app.fixture.ts")).overrideEol(),
  );
  await input.press(documentEnd);
  await input.pressSequentially("!");
  await input.press("ControlOrMeta+s");
  await expect
    .poll(() => readFileSync(shell, "utf8"))
    .toBe("echo first\r\necho second\r\necho third!");
  const windows = "echo first\r\necho second\r\necho third!";
  await expect
    .poll(() => snapshot(shell))
    .toMatchObject({ text: windows, savedContent: windows, dirty: false });
  report.savedCrLf = { editor: await snapshot(shell), disk: readFileSync(shell, "utf8") };
  report.browserErrors = await errors();
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  expect(report.browserErrors).toEqual([]);
});
