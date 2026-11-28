import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("same-name extension output channels retain independent text and lifetime", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-output-channels-"));
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const extension = join(extensions, "output-test");
  mkdirSync(workspace);
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "output-test",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:outputFixture.open"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const first = vscode.window.createOutputChannel("Shared title");
  const second = vscode.window.createOutputChannel("Shared title");
  subscriptions.push(first, second,
    vscode.commands.registerCommand("outputFixture.open", () => {
      first.append("before ");
      first.appendLine("first");
      first.append("after");
      second.appendLine("second");
      first.show();
    }),
    vscode.commands.registerCommand("outputFixture.replace", () => first.replace("replacement\\nlast")),
    vscode.commands.registerCommand("outputFixture.closeFirst", () => { first.dispose(); second.show(); }),
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
    const execute = (command: string) =>
      page.evaluate(
        async ({ sessionId, command }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(
            sessionId,
            command,
            [],
          ),
        { sessionId, command },
      );
    const contents = () => page.locator(".output-log").textContent();
    const channels = page.getByLabel("Output Channel").getByRole("option", {
      name: "Shared title",
      exact: true,
    });
    await execute("outputFixture.open");
    await expect(channels).toHaveCount(2);
    await expect.poll(contents).toBe("before first\nafter");
    await execute("outputFixture.replace");
    await expect.poll(contents).toBe("replacement\nlast");
    await execute("outputFixture.closeFirst");
    await expect(channels).toHaveCount(1);
    await expect.poll(contents).toBe("second\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
