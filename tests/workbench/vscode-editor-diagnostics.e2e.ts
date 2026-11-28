import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("editor markers reach extension diagnostics without echoing extension-owned markers", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "editor-diagnostics-"));
  try {
    const workspace = join(root, "workspace");
    const extensions = join(root, "extensions");
    const extension = join(extensions, "diagnostic-fixture");
    const initial = join(workspace, "initial.txt");
    const file = join(workspace, "open.txt");
    const foreign = join(root, "other.txt");
    mkdirSync(workspace);
    mkdirSync(extension, { recursive: true });
    for (const path of [initial, file, foreign]) writeFileSync(path, "fixture content");
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "diagnostic-fixture",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:diagnosticFixture.get"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  const first = vscode.languages.createDiagnosticCollection("same name");
  const second = vscode.languages.createDiagnosticCollection("same name");
  const events = [];
  subscriptions.push(first, second, vscode.languages.onDidChangeDiagnostics((e) => {
    events.push(e.uris.map(uri => uri.toString()));
  }));
  function command(name, handler) {
    subscriptions.push(vscode.commands.registerCommand("diagnosticFixture." + name, handler));
  }
  command("publish", (file) => {
    const uri = vscode.Uri.file(file);
    first.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 4), "Extension A")]);
    second.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 1, 0, 4), "Extension B")]);
  });
  command("open", async (file) => { await vscode.window.showTextDocument(vscode.Uri.file(file)); });
  command("get", (file) => vscode.languages.getDiagnostics(vscode.Uri.file(file)).map(diagnostic => ({
    message: diagnostic.message,
    source: diagnostic.source,
    severity: diagnostic.severity,
    standard: diagnostic instanceof vscode.Diagnostic && diagnostic.range instanceof vscode.Range,
    code: typeof diagnostic.code === "object"
      ? { value: diagnostic.code.value, target: diagnostic.code.target.toString() } : diagnostic.code,
    tags: diagnostic.tags,
    related: diagnostic.relatedInformation?.map(({ location, message }) => ({
      uri: location.uri.toString(),
      line: location.range.start.line,
      message,
    })),
  })));
  command("resetEvents", () => { events.length = 0; });
  command("events", () => events);
  command("disposeFirst", () => first.dispose());
};
`,
    );

    await page.goto("/");
    await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
    await page.evaluate(
      async ({ initial, foreign }) => {
        const fixture = await import("/tests/vscode-editor-diagnostics.fixture.ts");
        fixture.publishNativeDiagnostic(initial, true);
        fixture.publishNativeDiagnostic(foreign, true);
      },
      { initial, foreign },
    );
    await page.evaluate(
      async ({ workspace, extensions }) =>
        (await import("/tests/vscode-virtual-workbench.fixture.ts")).scanAndOpen(
          workspace,
          extensions,
          true,
        ),
      { workspace, extensions },
    );
    const currentHost = () =>
      page.evaluate(
        async (root) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).activeHost(root),
        workspace,
      );
    await expect.poll(currentHost).toBeTruthy();
    const sessionId = (await currentHost())!;
    const execute = (name: string, ...args: unknown[]) =>
      page.evaluate(
        async ({ sessionId, name, args }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            "diagnosticFixture." + name,
            args,
          ),
        { sessionId, name, args },
      );
    const markers = () =>
      page.evaluate(
        async (path) =>
          (await import("/tests/vscode-editor-diagnostics.fixture.ts")).markerMessages(path),
        file,
      );

    expect(await execute("get", initial)).toEqual([
      expect.objectContaining({ message: "Editor lint", standard: true }),
    ]);
    expect(await execute("get", foreign)).toEqual([]);
    await execute("publish", file);
    await execute("open", file);
    await expect.poll(markers).toEqual(["Extension A", "Extension B"]);
    await execute("resetEvents");

    await page.evaluate(
      async (path) =>
        (await import("/tests/vscode-editor-diagnostics.fixture.ts")).publishNativeDiagnostic(path),
      file,
    );
    const uri = pathToFileURL(file).href;
    await expect
      .poll(() => execute("get", file))
      .toEqual([
        expect.objectContaining({ message: "Extension A" }),
        expect.objectContaining({ message: "Extension B" }),
        expect.objectContaining({
          message: "Editor lint",
          standard: true,
          source: "monaco-fixture",
          severity: 1,
          code: { value: "E001", target: "https://example.org/docs#E001" },
          tags: [1],
          related: [{ uri, line: 0, message: "Original value" }],
        }),
      ]);
    await expect.poll(() => execute("events")).toEqual([[uri]]);
    await execute("disposeFirst");
    await expect.poll(markers).toEqual(["Editor lint", "Extension B"]);
    await page.evaluate(
      async (path) =>
        (await import("/tests/vscode-editor-diagnostics.fixture.ts")).clearNativeDiagnostic(path),
      file,
    );
    await expect
      .poll(() => execute("get", file))
      .toEqual([expect.objectContaining({ message: "Extension B" })]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
