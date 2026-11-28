import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExtensionContributions } from "../../packages/vscode-ext-host/src/contributions.ts";
import { readExtensionManifest } from "../../packages/vscode-ext-host/src/manifest.ts";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

test("official content defaults change production file editors, Tab insertion and saved EOL", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors = await captureBrowserErrors(page);
  const builtins =
    process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(!existsSync(join(builtins, "go/package.json")), "Requires official VS Code builtins");
  const manifests = await Promise.all(
    [
      "clojure",
      "coffeescript",
      "csharp",
      "docker",
      "fsharp",
      "go",
      "javascript",
      "julia",
      "make",
      "markdown-basics",
      "prompt-basics",
      "pug",
      "python",
      "ruby",
      "shellscript",
      "yaml",
    ].map((name) => readExtensionManifest(join(builtins, name))),
  );
  expect(manifests.every(Boolean)).toBe(true);
  const snapshots = await readExtensionContributions(
    manifests.filter((manifest) => manifest !== null),
  );
  snapshots.unshift({
    id: "audit.schema-defaults",
    contributes: { configuration: { properties: { "editor.tabSize": { default: 6 } } } },
    resources: {},
    errors: [],
  });
  await page.goto("/tests/vscode-content-configuration.fixture.html");
  await page.waitForFunction(
    () => (window as unknown as { contentConfigurationReady?: boolean }).contentConfigurationReady,
  );
  await page.evaluate(
    async (snapshots) =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).loadContentConfiguration(
        snapshots,
      ),
    snapshots,
  );
  const report: Record<string, unknown> = {};
  try {
    const settings: {
      extensionId: string;
      language: string;
      key: string;
      expected: unknown;
      actual?: unknown;
      unsupported?: boolean;
    }[] = [];
    for (const snapshot of snapshots)
      for (const [scope, values] of Object.entries(
        (snapshot.contributes.configurationDefaults as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {},
      )) {
        for (const [, language] of scope.matchAll(/\[([^\]]+)\]/g)) {
          const path = `defaults-${language}`;
          await page.evaluate(
            async (path) =>
              (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
                path,
                "first\r\nsecond\r\n",
              ),
            path,
          );
          const observed = await page.evaluate(
            async ({ path, language }) =>
              (
                await import("/tests/vscode-content-configuration.fixture.ts")
              ).switchContentLanguage(path, language),
            { path, language: language! },
          );
          for (const [key, expected] of Object.entries(values)) {
            const entry: (typeof settings)[number] = {
              extensionId: snapshot.id,
              language: language!,
              key,
              expected,
            };
            if (
              key === "diffEditor.ignoreTrimWhitespace" ||
              key === "editor.maxTokenizationLineLength"
            ) {
              entry.unsupported = true;
              settings.push(entry);
              continue;
            }
            if (key === "files.eol") {
              const saved = await page.evaluate(
                async (path) =>
                  (await import("/tests/vscode-content-configuration.fixture.ts")).saveContentFile(
                    path,
                  ),
                path,
              );
              entry.actual = saved.saved?.includes("\r") ? "\r\n" : "\n";
              expect.soft(saved.text, `${snapshot.id}: saved model`).toBe(saved.saved);
            } else if (key === "editor.insertSpaces") entry.actual = observed.model.insertSpaces;
            else if (key === "editor.tabSize") entry.actual = observed.model.tabSize;
            else if (key === "editor.unicodeHighlight.ambiguousCharacters")
              entry.actual = observed.options.unicodeHighlight.ambiguousCharacters;
            else if (key === "editor.unicodeHighlight.invisibleCharacters")
              entry.actual = observed.options.unicodeHighlight.invisibleCharacters;
            else
              entry.actual =
                observed.options[key.slice("editor.".length) as keyof typeof observed.options];
            const normalized =
              key === "editor.defaultColorDecorators"
                ? expected !== "never"
                : key === "editor.quickSuggestions"
                  ? Object.fromEntries(
                      Object.entries(expected as Record<string, unknown>).map(([key, value]) => [
                        key,
                        typeof value === "boolean" ? (value ? "on" : "off") : value,
                      ]),
                    )
                  : expected;
            if (normalized && typeof normalized === "object")
              expect
                .soft(entry.actual, `${snapshot.id}: [${language}] ${key}`)
                .toMatchObject(normalized as Record<string, unknown>);
            else
              expect.soft(entry.actual, `${snapshot.id}: [${language}] ${key}`).toEqual(normalized);
            settings.push(entry);
          }
        }
      }
    report.settings = settings;
    expect.soft(settings).toHaveLength(64);
    expect.soft(settings.filter((entry) => !entry.unsupported)).toHaveLength(51);
    for (const path of ["main.go", "Makefile"]) {
      const options = await page.evaluate(
        async (path) =>
          (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(path),
        path,
      );
      const inserted = await page.evaluate(async () =>
        (await import("/tests/vscode-content-configuration.fixture.ts")).insertContentTab(),
      );
      report[path] = { options, inserted };
      expect.soft(options.model.insertSpaces, path).toBe(false);
      expect.soft(options.model.tabSize, `${path}: schema default`).toBe(6);
      expect.soft(inserted.text, path).toBe("\t");
    }
    const userTabSize = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).setContentConfiguration(
        "editor.tabSize",
        9,
      ),
    );
    expect.soft(userTabSize.model.tabSize).toBe(9);
    const prompt = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
        "example.prompt.md",
      ),
    );
    report.prompt = prompt;
    expect.soft(prompt.language).toBe("prompt");
    expect.soft(prompt.options.wordWrap).toBe("on");
    expect.soft(prompt.wrapping.isViewportWrapping).toBe(true);
    expect.soft(prompt.options.autoIndent).toBe("advanced");
    expect.soft(prompt.options.wordBasedSuggestions).toBe("off");
    expect
      .soft(prompt.options.quickSuggestions)
      .toEqual({ comments: "off", strings: "on", other: "on" });
    expect
      .soft(prompt.options.unicodeHighlight)
      .toMatchObject({ ambiguousCharacters: false, invisibleCharacters: false });
    const promptWords = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).contentWordSuggestions(true),
    );
    expect.soft(promptWords).toEqual([]);
    const switched = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).switchContentLanguage(
        "example.prompt.md",
        "go",
      ),
    );
    report.switched = switched;
    expect.soft(switched.model.insertSpaces).toBe(false);
    expect.soft(switched.options.wordWrap).toBe("off");
    const goWords = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).contentWordSuggestions(),
    );
    expect.soft(goWords).toContain("uniqueContentWord");
    const grouped = await page.evaluate(async () => {
      const { setContentConfiguration } =
        await import("/tests/vscode-content-configuration.fixture.ts");
      await setContentConfiguration("[go][python]", { "editor.tabSize": 7 });
      return setContentConfiguration("[go][javascript]", null);
    });
    expect.soft(grouped.model.tabSize).toBe(7);
    const overridden = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).setContentConfiguration(
        "[go]",
        { "editor.insertSpaces": true, "editor.tabSize": 5 },
      ),
    );
    report.overridden = overridden;
    expect.soft(overridden.model.insertSpaces).toBe(true);
    expect.soft(overridden.model.tabSize).toBe(5);
    const overriddenTab = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).insertContentTab(),
    );
    expect.soft(overriddenTab.text).toBe("     ");
    const yaml = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
        "config.yaml",
      ),
    );
    report.yaml = yaml;
    expect.soft(yaml.model).toMatchObject({ insertSpaces: true, tabSize: 2 });
    expect.soft(yaml.options.autoIndent).toBe("advanced");
    expect.soft(yaml.options.quickSuggestions).toMatchObject({ strings: "on" });
    expect.soft(yaml.options.defaultColorDecorators).toBe(false);
    const shell = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
        "run.sh",
        "echo one\r\necho two\r\n",
      ),
    );
    const editedShell = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).insertContentTab(),
    );
    expect.soft(editedShell.dirty).toBe(true);
    const failed = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).failContentSave("run.sh"),
    );
    expect.soft(failed.error).toContain("Read-only fixture");
    expect.soft(failed.saved).toBe("echo one\r\necho two\r\n");
    expect.soft(failed.text).toBe(editedShell.text);
    expect.soft(failed.dirty).toBe(true);
    const saved = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).saveContentFile("run.sh"),
    );
    report.shell = { opened: shell, edited: editedShell, failed, saved };
    expect.soft(shell.eol).toBe("\r\n");
    expect.soft(shell.dirty).toBe(false);
    expect.soft(saved.saved).toBe(editedShell.text.replace(/\r\n/g, "\n"));
    expect.soft(saved.text).toBe(saved.saved);
    expect.soft(saved.document.content).toBe(saved.saved);
    expect.soft(saved.document.savedContent).toBe(saved.saved);
    expect.soft(saved.dirty).toBe(false);
    await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
        "mixed.sh",
        "first\r\nsecond\nthird\r",
      ),
    );
    const mixed = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).saveContentFile("mixed.sh"),
    );
    report.mixed = mixed;
    expect.soft(mixed.saved).toBe("first\nsecond\nthird\n");
    expect.soft(mixed.text).toBe(mixed.saved);
    await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).setContentConfiguration(
        "[shellscript]",
        { "files.eol": "\r\n" },
      ),
    );
    await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).openContentFile(
        "windows.sh",
        "first\nsecond\n",
      ),
    );
    const windows = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).saveContentFile(
        "windows.sh",
      ),
    );
    report.windows = windows;
    expect.soft(windows.saved).toBe("first\r\nsecond\r\n");
    expect.soft(windows.text).toBe(windows.saved);
    await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).setContentConfiguration(
        "editor.tabSize",
        undefined,
      ),
    );
    const removed = await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).replaceContentContributions(
        [],
      ),
    );
    report.removed = removed;
    expect.soft(removed.options.defaultColorDecorators).toBe(true);
    expect.soft(removed.model.tabSize).toBe(3);
  } finally {
    await page.evaluate(async () =>
      (await import("/tests/vscode-content-configuration.fixture.ts")).closeContentConfiguration(),
    );
    report.browserErrors = await browserErrors();
    const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      join(artifacts, "content-configuration-results.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  expect(report.browserErrors).toEqual([]);
});
