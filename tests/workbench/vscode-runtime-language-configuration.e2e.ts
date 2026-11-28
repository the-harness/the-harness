import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

test("extension language rules reach Monaco and restore the underlying rules when disposed", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-runtime-language-config-"));
  const extensions = join(root, "extensions");
  const extension = join(extensions, "rules");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "rules",
      version: "1.0.0",
      main: "./index.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  writeFileSync(
    join(extension, "index.cjs"),
    String.raw`
const vscode = require("vscode");
exports.activate = context => {
  const doc = vscode.workspace.textDocuments[0];
  const readWord = () => doc.getText(doc.getWordRangeAtPosition(new vscode.Position(0, 2)));
  let first;
  let second;
  context.subscriptions.push(
    vscode.commands.registerCommand("audit.rules", step => {
      if (step === "add") {
        first = vscode.languages.setLanguageConfiguration(doc.languageId, {
          comments: { lineComment: "#" },
          brackets: [["(", ")"]],
          __electricCharacterSupport: { docComment: { scope: "fixture", open: "/**", lineStart: "*", close: "*/" } },
          wordPattern: /[\p{L}-]+/gu,
          indentationRules: { increaseIndentPattern: /^begin$/i, decreaseIndentPattern: /^end$/i },
          onEnterRules: [{ beforeText: /^begin$/i, action: { indentAction: vscode.IndentAction.Indent } }],
          autoClosingPairs: [{ open: "(", close: ")", notIn: [vscode.SyntaxTokenType.Comment, vscode.SyntaxTokenType.String] }],
        });
        second = vscode.languages.setLanguageConfiguration(doc.languageId, {
          comments: { lineComment: ";;" },
        });
        context.subscriptions.push(first, second);
        let rejectsEmpty = false;
        try { vscode.languages.setLanguageConfiguration(doc.languageId, { wordPattern: /.*/g }); }
        catch { rejectsEmpty = true; }
        return { word: readWord(), rejectsEmpty };
      }
      if (step === "first") first.dispose();
      if (step === "second") second.dispose();
      return readWord();
    }),
  );
};
`,
  );
  const host = await createExtensionHostFixture();
  const session = "audit-runtime-config";
  const unlisten = host.service.onMainThreadCall(async (id, method, args, request) => {
    const result = method.startsWith("languages.")
      ? await page.evaluate(
          async ({ id, method, args }) =>
            (
              await import("/tests/vscode-runtime-language-configuration.fixture.ts")
            ).dispatchLanguageConfiguration(id, method, args),
          { id, method, args },
        )
      : undefined;
    host.service.resolveMainCall(request, result);
  });
  try {
    await page.goto("/tests/vscode-empty.fixture.html");
    const document = await page.evaluate(async () =>
      (
        await import("/tests/vscode-runtime-language-configuration.fixture.ts")
      ).openLanguageConfigurationFixture(),
    );
    await host.service.scanExtensions(extensions);
    await host.service.startSession(session, ["/fixture"], {
      documents: [document],
      storageRoot: join(root, "storage"),
    });
    await host.service.activateByEvent(session, "onStartupFinished");
    const observe = () =>
      page.evaluate(async () =>
        (
          await import("/tests/vscode-runtime-language-configuration.fixture.ts")
        ).observeLanguageConfiguration(),
      );
    const configure = (step: string) => host.service.executeCommand(session, "audit.rules", step);
    expect(await configure("initial")).toBe("alpha");
    expect(await observe()).toMatchObject({ word: "alpha", line: "// alpha-beta" });
    expect(await configure("add")).toEqual({ word: "alpha-beta", rejectsEmpty: true });
    await expect.poll(observe).toMatchObject({
      word: "alpha-beta",
      line: ";; alpha-beta",
      enter: "i",
      indentation: true,
      notIn: ["comment", "string"],
      legacyComment: "/**",
    });
    await page.evaluate(async () =>
      (
        await import("/tests/vscode-runtime-language-configuration.fixture.ts")
      ).refreshBaseLanguageConfiguration(),
    );
    expect(await observe()).toMatchObject({ line: ";; alpha-beta" });
    for (const visible of [false, true]) {
      await page.evaluate(
        async (visible) =>
          (
            await import("/tests/vscode-runtime-language-configuration.fixture.ts")
          ).setLanguageConfigurationForeground(visible),
        visible,
      );
      expect(await observe()).toMatchObject({ line: visible ? ";; alpha-beta" : "// alpha-beta" });
    }
    expect(await configure("first")).toBe("alpha");
    await expect.poll(observe).toMatchObject({ word: "alpha", line: ";; alpha-beta" });
    expect(await configure("second")).toBe("alpha");
    await expect.poll(observe).toMatchObject({ word: "alpha", line: "// alpha-beta" });
  } finally {
    await host.dispose(session);
    unlisten();
    await page.evaluate(async () =>
      (
        await import("/tests/vscode-runtime-language-configuration.fixture.ts")
      ).closeLanguageConfigurationFixture(),
    );
  }
});
