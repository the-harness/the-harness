import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("extension open and save dialogs return the paths chosen in the Workbench", async ({
  page,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-file-dialogs-"));
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const extension = join(extensions, "file-dialog");
  const nested = join(workspace, "nested");
  const firstFile = join(workspace, "alpha.ts");
  const secondFile = join(workspace, "beta.ts");
  const existing = join(workspace, "notes.txt");
  mkdirSync(nested, { recursive: true });
  mkdirSync(extension, { recursive: true });
  writeFileSync(firstFile, "");
  writeFileSync(secondFile, "");
  writeFileSync(existing, "keep the existing contents");
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "file-dialog",
      publisher: "test",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:fileDialog.open"],
    }),
  );
  writeFileSync(
    join(extension, "extension.cjs"),
    `
const vscode = require("vscode");
exports.activate = ({ subscriptions }) => {
  const result = uri => ([uri instanceof vscode.Uri, uri.fsPath]);
  subscriptions.push(vscode.commands.registerCommand("fileDialog.open", async path => {
    const uris = await vscode.window.showOpenDialog({
      title: "Pick workspace resources",
      defaultUri: vscode.Uri.file(path),
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Open selected resources",
      filters: { TypeScript: ["ts"], Text: ["txt"] },
    });
    return uris?.map(result) ?? null;
  }));
  subscriptions.push(vscode.commands.registerCommand("fileDialog.openFolder", async path => {
    const uris = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(path),
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: "Choose folder",
    });
    return uris?.map(result) ?? null;
  }));
  subscriptions.push(vscode.commands.registerCommand("fileDialog.save", async path => {
    const uri = await vscode.window.showSaveDialog({
      title: "Save a text file",
      defaultUri: vscode.Uri.file(path),
      saveLabel: "Use this path",
      filters: { Text: ["txt"] },
    });
    return uri ? result(uri) : null;
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
        ),
      { workspace, extensions },
    );
    const currentHost = () =>
      page.evaluate(async () =>
        (await import("/tests/vscode-virtual-workbench.fixture.ts")).activeHost(),
      );
    await expect.poll(currentHost).toBeTruthy();
    const sessionId = (await currentHost())!;
    const execute = (command: string, path: string) =>
      page.evaluate(
        async ({ sessionId, command, path }) =>
          (await import("/tests/vscode-virtual-workbench.fixture.ts")).execute(sessionId, command, [
            path,
          ]),
        { sessionId, command, path },
      );
    const dialog = page.getByRole("dialog");
    const entry = (name: string) => dialog.getByRole("option", { name, exact: true });
    const open = execute("fileDialog.open", firstFile);
    await expect(dialog).toHaveAccessibleName("Pick workspace resources");
    await expect(entry("alpha.ts")).toHaveAttribute("aria-selected", "true");
    await expect(entry("notes.txt")).toHaveCount(0);
    await dialog.getByLabel("File type").selectOption({ label: "Text" });
    await expect(entry("notes.txt")).toBeVisible();
    await expect(entry("alpha.ts")).toHaveCount(0);
    await dialog.getByLabel("File type").selectOption({ label: "TypeScript" });
    await entry("alpha.ts").click();
    await entry("beta.ts").click();
    await entry("nested").click();
    await dialog.getByRole("button", { name: "Open selected resources" }).click();
    expect(await open).toEqual([
      [true, firstFile],
      [true, secondFile],
      [true, nested],
    ]);

    const folder = execute("fileDialog.openFolder", workspace);
    await expect(entry("nested")).toBeVisible();
    await expect(entry("alpha.ts")).toHaveCount(0);
    await entry("nested").click();
    await dialog.getByRole("button", { name: "Choose folder" }).click();
    expect(await folder).toEqual([[true, nested]]);

    const cancel = execute("fileDialog.openFolder", workspace);
    await expect(dialog.getByRole("button", { name: "Choose folder" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await cancel).toBeNull();

    const save = execute("fileDialog.save", existing);
    const fileName = dialog.getByRole("textbox", { name: "File name" });
    await expect(fileName).toHaveValue("notes.txt");
    await fileName.fill("fresh document");
    await dialog.getByRole("button", { name: "Use this path" }).click();
    const freshPath = join(workspace, "fresh document.txt");
    expect(await save).toEqual([true, freshPath]);
    expect(existsSync(freshPath)).toBe(false);

    const overwrite = execute("fileDialog.save", existing);
    await expect(fileName).toHaveValue("notes.txt");
    const confirm = dialog.getByRole("button", { name: "Use this path" });
    const dismissed = page.waitForEvent("dialog").then(async (prompt) => {
      expect(prompt.type()).toBe("confirm");
      await prompt.dismiss();
    });
    await Promise.all([dismissed, confirm.click()]);
    await expect(confirm).toBeEnabled();
    const accepted = page.waitForEvent("dialog").then((prompt) => prompt.accept());
    await Promise.all([accepted, confirm.click()]);
    expect(await overwrite).toEqual([true, existing]);
    expect(readFileSync(existing, "utf8")).toBe("keep the existing contents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
