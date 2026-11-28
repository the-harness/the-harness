import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("displays a provider's virtual document in one read-only editor and releases it on close", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "virtual-workbench-"));
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const extension = join(extensions, "virtual-fixture");
  mkdirSync(workspace);
  mkdirSync(extension, { recursive: true });
  const languageExtension = join(extensions, "virtual-script");
  mkdirSync(languageExtension);
  writeFileSync(
    join(languageExtension, "package.json"),
    JSON.stringify({
      name: "virtual-script",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onLanguage:virtual-script"],
      contributes: { languages: [{ id: "virtual-script", firstLine: "^#!.*virtual-run" }] },
    }),
  );
  writeFileSync(
    join(languageExtension, "extension.cjs"),
    'exports.activate = () => require("vscode").workspace.textDocuments.find(doc => doc.languageId === "virtual-script")?.languageId;',
  );
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "virtual-fixture",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:virtualFixture.show"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    String.raw`
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const uri = vscode.Uri.parse("virtual-fixture://test/preview.ts?revision=1");
  const changes = new vscode.EventEmitter();
  let text = "Provider initial text";
  let document;
  let closed = 0;
  const provider = vscode.workspace.registerTextDocumentContentProvider(uri.scheme, {
    onDidChange: changes.event,
    provideTextDocumentContent: resource => resource.path === "/runner"
      ? "#!/usr/bin/env virtual-run\nprocess input"
      : text,
  });
  subscriptions.push(changes, provider,
    vscode.workspace.onDidCloseTextDocument(closing => { if (closing === document) closed++; }),
    vscode.commands.registerCommand("virtualFixture.show", async (label = "Provider revision") => {
      const result = await vscode.commands.executeCommand(
        "vscode.open",
        uri,
        { selection: new vscode.Range(0, 0, 0, 8) },
        label,
      );
      const editor = vscode.window.activeTextEditor;
      const same = editor.document === document;
      document = editor.document;
      return {
        returnedVoid: result === undefined,
        selection: document.getText(editor.selection),
        uri: document.uri.toString(),
        language: document.languageId,
        same,
        saved: await document.save(),
        edited: await editor.edit(edit => edit.insert(new vscode.Position(0, 0), "forbidden ")),
      };
    }),
    vscode.commands.registerCommand("virtualFixture.languages", async () => {
      const script = await vscode.workspace.openTextDocument(uri.with({ path: "/runner" }));
      const unknown = await vscode.workspace.openTextDocument(uri.with({ path: "/unknown" }));
      return { script: script.languageId, unknown: unknown.languageId };
    }),
    vscode.commands.registerCommand("virtualFixture.activatedLanguage", () =>
      vscode.extensions.getExtension("test.virtual-script").exports),
    vscode.commands.registerCommand("virtualFixture.openLink", url => vscode.commands.executeCommand("vscode.open", url)),
    vscode.commands.registerCommand("virtualFixture.refresh", () => {
      text = "Provider refreshed text";
      changes.fire(uri);
    }),
    vscode.commands.registerCommand("virtualFixture.closed", () => ({ count: closed, isClosed: document.isClosed })),
    vscode.commands.registerCommand("virtualFixture.dispose", () => provider.dispose()),
  );
};
`,
  );
  try {
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
    const execute = (command: string, args: unknown[] = []) =>
      page.evaluate(
        async ({ sessionId, command, args }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            command,
            args,
          ),
        { sessionId, command, args },
      );
    const uri = "virtual-fixture://test/preview.ts?revision%3D1";
    const tab = page.getByRole("tab", { name: /Provider revision/ });
    const lines = page.locator(".virtual-text-editor .view-lines");
    expect(await execute("virtualFixture.show")).toEqual({
      uri,
      language: "typescript",
      returnedVoid: true,
      selection: "Provider",
      same: false,
      edited: false,
      saved: false,
    });
    await expect(lines).toContainText("Provider initial text");
    expect(
      await page.evaluate(
        async (uri) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).modelLanguage(uri),
        uri,
      ),
    ).toBe("typescript");
    expect(await execute("virtualFixture.languages")).toEqual({
      script: "virtual-script",
      unknown: "plaintext",
    });
    await expect.poll(() => execute("virtualFixture.activatedLanguage")).toBe("virtual-script");
    await lines.click();
    await page.keyboard.insertText("forbidden");
    await expect(lines).toContainText("Provider initial text");
    await expect(lines).not.toContainText("forbidden");
    expect(await execute("virtualFixture.show", ["Updated revision"])).toMatchObject({
      same: true,
    });
    const updatedTab = page.getByRole("tab", { name: /Updated revision/ });
    await expect(tab).toHaveCount(0);
    await expect(updatedTab).toHaveCount(1);
    await execute("virtualFixture.refresh");
    await expect(lines).toContainText("Provider refreshed text");
    await updatedTab.getByRole("button", { name: "Close Updated revision" }).click();
    await expect(updatedTab).toHaveCount(0);
    await expect.poll(() => execute("virtualFixture.closed")).toEqual({ count: 1, isClosed: true });
    expect(
      await page.evaluate(
        async (uri) => (await import("/tests/vscode-virtual-workbench.fixture.ts")).modelValue(uri),
        uri,
      ),
    ).toBeUndefined();
    expect(await execute("virtualFixture.show")).toMatchObject({ same: false });
    await execute("virtualFixture.dispose");
    await expect(tab).toHaveCount(0);
    const url = "https://example.test/docs?token=a%2Bb&display=full#history";
    const opened = await page.evaluate(
      async ({ url, sessionId }) => {
        const fixture = await import("/tests/vscode-virtual-workbench.fixture.ts");
        const open = window.open;
        let href: string | undefined;
        window.open = (target) => {
          href = String(target);
          return null;
        };
        try {
          await fixture.execute(sessionId, "virtualFixture.openLink", [url]);
          return href;
        } finally {
          window.open = open;
        }
      },
      { url, sessionId },
    );
    expect(opened).toBe(url);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
