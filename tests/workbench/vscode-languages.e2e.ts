import { expect, test } from "@playwright/test";

test("VS Code language results and diagnostics reach real Monaco models with standard metadata", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const result = await page.evaluate(async (moduleUrl) => {
    const fixture = await import(moduleUrl);
    return fixture.observeLanguageConversions();
  }, "/tests/vscode-languages.fixture.ts");
  const target = "vscode-remote://ssh-remote+fixture/fixture/target.ts?view=2#target";
  expect(result.completion).toMatchObject({
    incomplete: true,
    label: { label: "hello", detail: "()", description: "fixture" },
    kind: result.completion.expectedKind,
    insertText: "hello($1)",
    insertAsSnippet: true,
    range: {
      insert: { startLineNumber: 1, startColumn: 1, endColumn: 6 },
      replace: { endColumn: 8 },
    },
    documentation: {
      value: "**documentation**",
      isTrusted: { enabledCommands: ["fixture.run"] },
      supportHtml: true,
      supportThemeIcons: true,
      baseUri: target,
    },
    command: { id: "fixture.run", arguments: [42] },
    resolvedDetail: "resolved",
  });
  expect(result.definition).toMatchObject({
    uri: target,
    range: { startLineNumber: 2, endLineNumber: 4 },
    targetSelectionRange: { startColumn: 2, endColumn: 5 },
    originSelectionRange: { startLineNumber: 1, endColumn: 6 },
  });
  expect(result.inline).toMatchObject({
    insertText: { snippet: "hello($1)" },
    command: { id: "fixture.run" },
  });
  expect(result.action).toMatchObject({
    kinds: ["quickfix"],
    kind: "quickfix",
    disabled: "fixture",
    preferred: true,
    resource: "vscode-remote://ssh-remote+fixture/fixture/main.ts?view=1#source",
    command: { id: "fixture.run", title: "Resolved" },
    textAfterEdit: "fixed()\nworld",
  });
  expect(result.signature).toEqual({
    triggers: ["("],
    retriggers: [","],
    parameters: [{ label: [6, 11], documentation: "value" }],
  });
  expect(result.inlay).toMatchObject({
    label: [{ label: ": string", command: { id: "fixture.run" }, location: target }],
    tooltip: "resolved",
    paddingLeft: true,
    textEdits: [{ text: ": string" }],
    released: 1,
  });
  expect(result.colors).toMatchObject([{ label: "red", textEdit: { text: "#f00" } }]);
  expect(result.markers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: "pending",
        severity: 4,
        source: "fixture",
        code: { value: "17", target },
        related: target,
      }),
      expect.objectContaining({ message: "other", severity: 2 }),
    ]),
  );
  expect(result.remaining).toEqual(["other"]);
  expect(result.seen).toMatchObject({
    completion: {
      identity: true,
      text: "hello()\nworld",
      token: true,
      context: { triggerKind: 1, triggerCharacter: "." },
    },
    inline: { triggerKind: 0, selectedCompletionInfo: { text: "hello" } },
    action: { identity: true, contains: true, only: "quickfix", trigger: 1, token: true },
    color: { red: 1, identity: true, contains: true, token: true },
  });
  expect(errors).toEqual([]);
});
