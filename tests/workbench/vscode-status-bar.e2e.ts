import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("extension status bar items preserve commands and restore stacked messages", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-status-bar-"));
  try {
    const workspace = join(root, "workspace");
    const extensions = join(root, "extensions");
    const extension = join(extensions, "status-fixture");
    mkdirSync(workspace);
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "status-fixture",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:statusFixture.install"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  let item;
  let unnamed;
  let base;
  let finishMessage;
  let clicked = false;
  const payload = {};
  payload.self = payload;

  function register(id, run) {
    subscriptions.push(vscode.commands.registerCommand("statusFixture." + id, run));
  }

  register("install", () => {
    const right = vscode.StatusBarAlignment.Right;
    item = vscode.window.createStatusBarItem("sync-fixture", right, 10);
    item.name = "Fixture Sync";
    item.text = "$(sync~spin) Sync status";
    item.tooltip = new vscode.MarkdownString("**Fixture help**");
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    item.accessibilityInformation = { label: "Open fixture sync" };
    item.command = { title: "Run Sync", command: "statusFixture.click", arguments: [payload] };
    item.show();
    unnamed = vscode.window.createStatusBarItem();
    subscriptions.push(item, unnamed);
    return {
      id: item.id,
      name: item.name,
      alignment: item.alignment,
      priority: item.priority,
      unnamed: unnamed.id,
    };
  });
  register("click", (argument) => { clicked = argument === payload; });
  register("clicked", () => clicked);
  register("clear", () => {
    item.command = undefined;
    item.tooltip = undefined;
    item.backgroundColor = undefined;
    item.accessibilityInformation = undefined;
  });
  register("hide", () => item.hide());
  register("show", () => item.show());
  register("dispose", () => item.dispose());
  register("stack", () => {
    base = vscode.window.setStatusBarMessage("Persistent status");
    subscriptions.push(base);
    subscriptions.push(vscode.window.setStatusBarMessage("Pending status", new Promise((resolve) => {
      finishMessage = resolve;
    })));
  });
  register("finish", () => { finishMessage(); });
  register("timed", () => {
    subscriptions.push(vscode.window.setStatusBarMessage("Timed status", 1600));
  });
  register("clearBase", () => base.dispose());
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
    const execute = (id: string) =>
      page.evaluate(
        async ({ sessionId, id }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            "statusFixture." + id,
            [],
          ),
        { sessionId, id },
      );

    expect(await execute("install")).toEqual({
      id: "sync-fixture",
      name: "Fixture Sync",
      alignment: 2,
      priority: 10,
      unnamed: "test.status-fixture",
    });
    const bar = page.locator("footer.statusbar");
    const item = bar.getByRole("button", { name: "Open fixture sync" });
    await expect(item.locator(".codicon-sync.codicon-modifier-spin")).toBeVisible();
    await expect(item).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(
      await item.evaluate((element) => {
        const siblings = Array.from(element.parentElement!.children);
        const divider = siblings.findIndex((sibling) => sibling.classList.contains("spacer"));
        return divider >= 0 && siblings.indexOf(element) > divider;
      }),
    ).toBe(true);
    await item.hover();
    await expect(page.locator(".workbench-status-tooltip strong")).toHaveText("Fixture help");
    await item.press("Enter");
    await expect.poll(() => execute("clicked")).toBe(true);
    await execute("clear");
    await expect(item).toHaveCount(0);
    const label = bar.getByText("Sync status", { exact: true });
    await expect(label).toBeVisible();
    await label.hover();
    await expect(page.locator(".workbench-status-tooltip")).toHaveCount(0);
    await execute("hide");
    await expect(label).toHaveCount(0);
    await execute("show");
    await expect(label).toBeVisible();
    await execute("dispose");
    await expect(label).toHaveCount(0);

    const base = bar.getByText("Persistent status", { exact: true });
    await execute("stack");
    await expect(bar.getByText("Pending status", { exact: true })).toBeVisible();
    await expect(base).toHaveCount(0);
    await execute("finish");
    await expect(base).toBeVisible();
    await execute("timed");
    await expect(bar.getByText("Timed status", { exact: true })).toBeVisible();
    await expect(base).toBeVisible();
    await execute("clearBase");
    await expect(base).toHaveCount(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
