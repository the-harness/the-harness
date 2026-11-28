import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("SCM rows open workspace files or run the extension's resource command", async ({ page }) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-scm-"));
  try {
    const workspace = join(root, "workspace");
    const extensions = join(root, "extensions");
    const extension = join(extensions, "scm-resource-fixture");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(workspace, "nested", "workspace #1.txt"), "Opened from the SCM file row");
    writeFileSync(join(workspace, "command result.txt"), "Opened by the extension command");
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "scm-resource-fixture",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:scmResourceFixture.install"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const { join } = require("node:path");
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  const args = {};
  args.self = args;
  let activation;
  subscriptions.push(
    vscode.commands.registerCommand("scmResourceFixture.install", (root) => {
      const source = vscode.scm.createSourceControl("resource-fixture", "Resource Fixture", vscode.Uri.file(root));
      subscriptions.push(source);
      const file = vscode.Uri.file(join(root, "nested", "workspace #1.txt"));
      const virtual = file.with({ scheme: "scm-resource-fixture", query: "revision=staged" });
      args.target = vscode.Uri.file(join(root, "command result.txt"));
      const group = source.createResourceGroup("changes", "Fixture Changes");
      group.resourceStates = [
        { resourceUri: file, decorations: { tooltip: "Extension-provided tooltip", strikeThrough: true } },
        {
          resourceUri: virtual.with({ path: file.path.replace("workspace #1.txt", "registered action.txt") }),
          command: { command: "scmResourceFixture.open", title: "Open Review", arguments: [args] },
        },
        { resourceUri: virtual.with({ path: file.path.replace("workspace #1.txt", "virtual no action.txt") }) },
      ];
      source.createResourceGroup("hidden", "Hidden Fixture Group").hideWhenEmpty = true;
    }),
    vscode.commands.registerCommand("scmResourceFixture.open", async (actualArgs, preserveFocus) => {
      activation = { same: actualArgs === args, preserveFocus };
      await vscode.window.showTextDocument(actualArgs.target);
    }),
    vscode.commands.registerCommand("scmResourceFixture.activation", () => activation ?? null),
  );
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
    await execute("scmResourceFixture.install", [workspace]);

    const panel = page.locator(".changes-panel");
    if (!(await panel.isVisible())) {
      await page.getByRole("button", { name: "Toggle Secondary Side Bar" }).click();
    }
    const lines = page.locator(".file-editor-view:visible .view-lines");
    const file = panel.getByRole("button", { name: "workspace #1.txt", exact: true });
    await expect(file).toHaveAttribute("title", "Extension-provided tooltip");
    await expect(file.locator(".scm-resource-name")).toHaveCSS(
      "text-decoration-line",
      "line-through",
    );
    await expect(panel.getByText("Hidden Fixture Group")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "virtual no action.txt" })).toBeDisabled();

    await file.click();
    await expect(page.getByRole("tab", { name: /workspace #1\.txt/ })).toBeVisible();
    await expect(lines).toContainText("Opened from the SCM file row");

    await panel.getByRole("button", { name: "registered action.txt" }).press("Enter");
    await expect
      .poll(() => execute("scmResourceFixture.activation"))
      .toEqual({
        same: true,
        preserveFocus: false,
      });
    await expect(page.getByRole("tab", { name: /command result\.txt/ })).toBeVisible();
    await expect(lines).toContainText("Opened by the extension command");
    await expect(page.getByRole("tab", { name: /registered action\.txt/ })).toHaveCount(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
