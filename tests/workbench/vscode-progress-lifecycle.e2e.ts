import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("extension progress updates its location and cancels without settling its task", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-progress-"));
  try {
    const workspace = join(root, "workspace");
    const extensions = join(root, "extensions");
    const extension = join(extensions, "progress-fixture");
    mkdirSync(workspace);
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "progress-fixture",
        publisher: "test",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onCommand:progressFixture.start"],
      }),
    );
    writeFileSync(
      join(extension, "extension.cjs"),
      `
const vscode = require("vscode");

exports.activate = ({ subscriptions }) => {
  const operations = new Map();
  const results = new Map();
  const events = new Map();
  const view = "progress.fixtureView";
  subscriptions.push(vscode.window.createTreeView(view, {
    treeDataProvider: {
      getChildren: () => ["Fixture row"],
      getTreeItem: (label) => new vscode.TreeItem(label),
    },
  }));
  function register(id, run) {
    subscriptions.push(vscode.commands.registerCommand("progressFixture." + id, run));
  }

  register("start", (title, location, cancellable) => {
    void vscode.window.withProgress({ title, location, cancellable }, async (progress, token) => {
      const gate = new Promise((resolve, reject) => {
        operations.set(title, { progress, token, resolve, reject });
      });
      token.onCancellationRequested(() => {
        events.set(title, (events.get(title) ?? 0) + 1);
      });
      const value = await gate;
      return { value, cancelled: token.isCancellationRequested };
    }).then(
      (result) => results.set(title, result),
      (error) => results.set(title, { error: error.message }),
    );
  });
  register("report", (title, change) => operations.get(title).progress.report(change));
  register("finish", (title) => operations.get(title).resolve("finished"));
  register("fail", (title) => operations.get(title).reject(new Error("fixture failed")));
  register("result", (title) => results.get(title) ?? null);
  register("cancelState", (title) => ({
    events: events.get(title) ?? 0,
    token: operations.get(title).token.isCancellationRequested,
  }));
  register("openView", () => vscode.commands.executeCommand(view + ".focus"));
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
    const execute = (command: string, ...args: unknown[]) =>
      page.evaluate(
        async ({ sessionId, command, args }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            "progressFixture." + command,
            args,
          ),
        { sessionId, command, args },
      );

    const notification = page.locator(".extension-progress-notifications");
    const scan = notification.getByRole("progressbar", { name: "Scan fixture" });
    const index = notification.getByRole("progressbar", { name: "Resolve index" });
    await execute("start", "Scan fixture", 15, true);
    await execute("start", "Resolve index", 15, false);
    await expect(scan).toBeVisible();
    await expect(index).toBeVisible();
    await expect(scan).not.toHaveAttribute("aria-valuenow", /.+/);
    await execute("report", "Scan fixture", { message: "Reading", increment: 20 });
    await execute("report", "Scan fixture", { increment: 25 });
    await expect(scan).toHaveAttribute("aria-valuenow", "45");
    await expect(notification.getByText("Reading", { exact: true })).toBeVisible();
    await notification.getByRole("button", { name: "Cancel Scan fixture" }).click();
    await expect(scan).toHaveCount(0);
    await expect(index).toBeVisible();
    await expect
      .poll(() => execute("cancelState", "Scan fixture"))
      .toEqual({ events: 1, token: true });
    expect(await execute("result", "Scan fixture")).toBeNull();
    await execute("finish", "Scan fixture");
    await expect
      .poll(() => execute("result", "Scan fixture"))
      .toEqual({ value: "finished", cancelled: true });
    await execute("fail", "Resolve index");
    await expect(index).toHaveCount(0);
    await expect
      .poll(() => execute("result", "Resolve index"))
      .toEqual({ error: "fixture failed" });

    const windowProgress = page.locator("footer .extension-progress-window");
    await execute("start", "Window fixture", 10, false);
    await expect(windowProgress).toContainText("Window fixture");
    await expect(notification).toHaveCount(0);
    await execute("finish", "Window fixture");
    await expect(windowProgress).toHaveCount(0);

    if (!(await page.locator(".changes-panel").isVisible())) {
      await page.getByRole("button", { name: "Toggle Secondary Side Bar" }).click();
    }
    await execute("start", "Scan changes", 1, false);
    const scmProgress = page
      .locator(".workbench-view-header")
      .getByRole("progressbar", { name: "Scan changes" });
    await expect(scmProgress).toBeVisible();
    await execute("finish", "Scan changes");
    await expect(scmProgress).toHaveCount(0);

    await execute("openView");
    await execute("start", "Refresh fixture view", { viewId: "progress.fixtureView" }, false);
    const viewProgress = page
      .locator('[data-tree-view="progress.fixtureView"]')
      .getByRole("progressbar", { name: "Refresh fixture view" });
    await expect(viewProgress).toBeVisible();
    await execute("finish", "Refresh fixture view");
    await expect(viewProgress).toHaveCount(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
