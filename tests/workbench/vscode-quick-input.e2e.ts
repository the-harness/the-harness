import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("extension quick input preserves the selected items and handles cancellation and validation", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-quick-input-"));
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const extension = join(extensions, "quick-input");
  mkdirSync(workspace);
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "quick-input",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:quickInput.configuration", "onCommand:quickInput.pick"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  let cancellation;
  const first = { label: "Candidate", description: "First", picked: true };
  const second = { label: "Candidate", description: "Second", detail: "searchable" };
  second.privateValue = second;
  const commands = {
    configuration() {
      return vscode.workspace.getConfiguration("editor").get("tabSize", 4);
    },
    async pick(many) {
      const selected = await vscode.window.showQuickPick(Promise.resolve([first, second]), {
        title: "Pick candidates", canPickMany: many, matchOnDetail: true,
      });
      return many ? selected.map(item => item === first ? 1 : item === second ? 2 : 0) : selected === second;
    },
    async cancelBeforeItems() {
      const source = new vscode.CancellationTokenSource();
      const result = vscode.window.showQuickPick(new Promise(() => {}), {}, source.token);
      source.cancel();
      return (await result) === undefined;
    },
    async cancellable() {
      cancellation = new vscode.CancellationTokenSource();
      try {
        return (await vscode.window.showQuickPick(["Wait for cancellation"], {
          title: "Cancelable pick",
        }, cancellation.token)) === undefined;
      } finally {
        cancellation.dispose();
      }
    },
    cancel() { cancellation.cancel(); },
    input() {
      return vscode.window.showInputBox({
        title: "Validate input in worker",
        validateInput: async value => value === "good"
          ? { message: "Advisory", severity: vscode.InputBoxValidationSeverity.Warning }
          : { message: "Enter good", severity: vscode.InputBoxValidationSeverity.Error },
      });
    },
  };
  for (const [name, handler] of Object.entries(commands))
    subscriptions.push(vscode.commands.registerCommand("quickInput." + name, handler));
};
`,
  );
  try {
    await page.goto("/");
    await expect(page.getByText("Search commands", { exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+n");
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
    const dialog = page.getByRole("dialog");
    const field = dialog.getByRole("combobox").or(dialog.getByRole("textbox"));
    expect(await execute("quickInput.configuration")).toBe(4);
    const single = execute("quickInput.pick", [false]);
    await expect(dialog.getByText("Pick candidates")).toBeVisible();
    await field.fill("searchable");
    await expect(dialog.getByText("First", { exact: true })).toHaveCount(0);
    await field.press("Enter");
    expect(await single).toBe(true);

    const many = execute("quickInput.pick", [true]);
    await expect(dialog.getByRole("checkbox", { name: "Candidate First" })).toBeChecked();
    await dialog.getByRole("checkbox", { name: "Candidate Second" }).check();
    await dialog.getByRole("button", { name: "OK" }).click();
    expect(await many).toEqual([1, 2]);

    expect(await execute("quickInput.cancelBeforeItems")).toBe(true);
    await expect(dialog).toHaveCount(0);
    const pending = execute("quickInput.cancellable");
    await expect(dialog.getByText("Cancelable pick")).toBeVisible();
    await execute("quickInput.cancel");
    expect(await pending).toBe(true);
    await expect(dialog).toHaveCount(0);

    const input = execute("quickInput.input");
    await expect(dialog.getByText("Validate input in worker")).toBeVisible();
    await field.fill("bad");
    await expect(dialog.getByText("Enter good")).toBeVisible();
    await field.press("Enter");
    await expect(dialog.getByText("Enter good")).toBeVisible();
    await field.fill("good");
    await expect(dialog.getByText("Advisory")).toBeVisible();
    await field.press("Enter");
    expect(await input).toBe("good");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
