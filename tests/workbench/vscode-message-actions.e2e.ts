import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("extension messages return the original action or resolve on dismissal", async ({ page }) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-messages-"));
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const extension = join(extensions, "message-fixture");
  mkdirSync(workspace);
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "message-fixture",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:messageFixture.show"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  subscriptions.push(vscode.commands.registerCommand("messageFixture.show", async (kind) => {
    if (kind === "warning") {
      const first = { title: "Select item" };
      const second = { title: "Select item" };
      second.extensionState = second;
      const picked = await vscode.window.showWarningMessage("Extension warning", first, second);
      return picked === second;
    }
    if (kind === "modal") {
      const cancel = { title: "Keep working", isCloseAffordance: true };
      const picked = await vscode.window.showErrorMessage(
        "Extension confirmation",
        { modal: true, detail: "An extension can provide additional detail." },
        { title: "Proceed" },
        cancel,
      );
      return picked === cancel;
    }
    const picked = await vscode.window.showInformationMessage("Extension information", "Accept");
    return picked ?? null;
  }));
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
          true,
        ),
      { workspace, extensions },
    );
    const currentHost = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-virtual-workbench.fixture.ts")).activeHost(),
      );
    await expect.poll(currentHost).toBeTruthy();
    const sessionId = (await currentHost())!;
    const execute = (kind: string) =>
      page.evaluate(
        async ({ sessionId, kind }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            "messageFixture.show",
            [kind],
          ),
        { sessionId, kind },
      );

    const warning = page.locator('.ui-notification-toast[data-severity="warning"]');
    const [selected] = await Promise.all([
      execute("warning"),
      warning.getByRole("button", { name: "Select item", exact: true }).nth(1).click(),
    ]);
    expect(selected).toBe(true);
    await expect(warning).toHaveCount(0);

    const dialog = page.getByRole("alertdialog", { name: "Extension confirmation" });
    const [canceled] = await Promise.all([
      execute("modal"),
      (async () => {
        await expect(dialog).toContainText("An extension can provide additional detail.");
        await expect(dialog.getByRole("button", { name: "Keep working" })).toBeFocused();
        await page.keyboard.press("Escape");
      })(),
    ]);
    expect(canceled).toBe(true);
    await expect(dialog).toHaveCount(0);

    const info = page
      .locator('.ui-notification-toast[data-severity="info"]')
      .filter({ hasText: "Extension information" });
    const [accepted] = await Promise.all([
      execute("info"),
      info.getByRole("button", { name: "Accept" }).click(),
    ]);
    expect(accepted).toBe("Accept");

    const [dismissed] = await Promise.all([
      execute("info"),
      info.getByRole("button", { name: "Dismiss notification" }).click(),
    ]);
    expect(dismissed).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
