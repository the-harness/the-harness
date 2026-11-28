import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExtensionContributions } from "../../packages/vscode-ext-host/src/contributions.ts";
import { readExtensionManifest } from "../../packages/vscode-ext-host/src/manifest.ts";

test("installed content-only builtins feed real Monaco grammars, snippets, themes and file icons", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const builtins =
    process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
    process.env.HARNESS_VSCODE_BUILTINS_DIR ??
    "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
  test.skip(
    !existsSync(join(builtins, "theme-defaults/package.json")),
    "Requires the installed VS Code built-in contribution resources",
  );
  const product = JSON.parse(readFileSync(join(builtins, "../product.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(builtins, "../package.json"), "utf8")).version;
  const plans = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../fixtures/vscode-builtin-content-cases.json", import.meta.url)),
      "utf8",
    ),
  );
  expect(plans).toHaveLength(61);
  const manifests = await Promise.all(
    plans.map((entry: any) => readExtensionManifest(join(builtins, entry.directory))),
  );
  expect(manifests.every(Boolean)).toBe(true);
  const snapshots = await readExtensionContributions(
    manifests.filter((manifest) => manifest !== null),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log("Contribution response", response.status(), response.url());
  });
  await page.goto("/tests/vscode-builtin-contributions.fixture.html");
  await page.waitForFunction(
    () => (window as unknown as { builtinContributionsReady?: boolean }).builtinContributionsReady,
  );
  const report = await page.evaluate(
    async ({ snapshots, plans }) => {
      const fixture = (
        window as unknown as {
          builtinContributionsFixture: typeof import("../../apps/web/tests/vscode-builtin-contributions.fixture.ts");
        }
      ).builtinContributionsFixture;
      return fixture.consumeBuiltinContributions(snapshots, plans);
    },
    { snapshots, plans },
  );
  mkdirSync(fileURLToPath(new URL("../../temp/artifacts/", import.meta.url)), { recursive: true });
  writeFileSync(
    fileURLToPath(new URL("../../temp/artifacts/builtin-content-results.json", import.meta.url)),
    JSON.stringify(
      {
        version,
        commit: product.commit,
        testedAt: new Date().toISOString(),
        ...report,
        browserErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  expect(report.results).toHaveLength(61);
  for (const association of report.associations)
    expect.soft(association.actual, association.path).toBe(association.expected);
  expect(report.issues).toEqual([]);
  for (const result of report.results) {
    expect.soft(result.errors, result.id).toEqual([]);
    for (const language of result.language) {
      expect.soft(language.installedGrammar?.extensionId, result.id).toBe(result.id);
      expect.soft(language.detected, result.id).toBe(language.requested);
      expect
        .soft(
          language.scopes.some((scope: string) => scope.includes(" ")),
          `${result.id}: ${language.scopes.join(",")}`,
        )
        .toBe(true);
      if (language.comment)
        expect.soft(language.comment.after, result.id).toContain(language.comment.expected);
      if (language.comment?.expectedEnd)
        expect.soft(language.comment.after, result.id).toContain(language.comment.expectedEnd);
    }
    for (const snippet of result.snippets) {
      expect.soft(snippet.provider, `${result.id}: ${snippet.language}`).toBe(true);
      if (snippet.body === snippet.prefix)
        expect.soft(snippet.inserted, `${result.id}: ${snippet.name}`).toBe(snippet.body);
      else expect.soft(snippet.inserted, `${result.id}: ${snippet.name}`).not.toBe(snippet.prefix);
      expect.soft(snippet.versionChanged, `${result.id}: ${snippet.name}`).toBe(true);
      if (snippet.template && snippet.language === "html") {
        expect.soft(snippet.inserted).toContain("<!DOCTYPE html>");
        expect.soft(snippet.selectedText).toBe("title");
      } else if (snippet.template) {
        expect.soft(snippet.inserted).toContain("class name");
        expect.soft(snippet.selectedText).toBe("name");
      }
      expect.soft(snippet.inserted, `${result.id}: ${snippet.name}`).not.toMatch(/\$\{?\d/);
    }
    for (const theme of result.themes) {
      expect.soft(theme.selected, `${result.id}: ${theme.id}`).toBeTruthy();
      expect
        .soft(theme.editorBackground, `${result.id}: ${theme.id}`)
        .toBe(theme.expectedBackground);
      expect.soft(theme.colorMap, `${result.id}: ${theme.id}`).toBe(true);
    }
    for (const icon of result.icons) {
      expect.soft(icon.className, `${result.id}: ${icon.id}`).toContain("vscode-contribution-");
      expect
        .soft(
          icon.imageDecoded ||
            (icon.content !== "none" && icon.content !== "normal" && icon.fontLoaded),
          `${result.id}: ${icon.id}`,
        )
        .toBe(true);
    }
  }
  expect(errors).toEqual([]);
});
