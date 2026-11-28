import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

function folderRow(page: Page, folder: string) {
  return page
    .getByRole("list", { name: "Workspace folders" })
    .getByRole("listitem")
    .filter({ has: page.getByText(folder, { exact: true }) });
}

function workspaceFolders(page: Page, id: string) {
  return page.evaluate(
    async (id) => (await import("/tests/workspace-folder-edit.fixture.ts")).workspaceFolders(id),
    id,
  );
}

test("workspace folder edits follow the same path through changes from another tab", async ({
  page,
  context,
}) => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "workspace-folder-edit-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const third = join(root, "third");
  const fourth = join(root, "fourth");
  const fifth = join(root, "fifth");
  const duplicate = join(root, "duplicate");
  const renamed = join(root, "renamed");
  const trailingFolders = [fifth, duplicate, duplicate];
  const initialFolders = [first, second, third, fourth, ...trailingFolders];
  let id: string | undefined;

  try {
    await Promise.all([...new Set([...initialFolders, renamed])].map((folder) => mkdir(folder)));
    await page.goto("/tests/workspace-folder-edit.fixture.html");
    const workspaceId = await page.evaluate(
      async (folders) =>
        (await import("/tests/workspace-folder-edit.fixture.ts")).createWorkspace(folders),
      initialFolders,
    );
    id = workspaceId;
    const peer = await context.newPage();
    await peer.goto("/tests/workspace-folder-edit.fixture.html");
    await expect.poll(() => workspaceFolders(peer, workspaceId)).toEqual(initialFolders);
    await peer.evaluate(
      async (id) => (await import("/tests/workspace-folder-edit.fixture.ts")).selectWorkspace(id),
      workspaceId,
    );

    const editor = page.getByRole("textbox", { name: "Edit folder path" });
    const menu = page.getByRole("menu", { name: "Workspace folder actions", exact: true });
    await folderRow(page, second).press("Shift+F10");
    await expect(menu.getByRole("menuitem", { name: "Edit Folder", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(folderRow(page, second)).toBeFocused();
    await folderRow(page, second).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Edit Folder", exact: true }).click();
    await editor.fill(renamed);
    await folderRow(peer, first).press("Delete");
    await expect(folderRow(page, first)).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(renamed);
    await editor.press("Enter");
    await expect
      .poll(() => workspaceFolders(peer, workspaceId))
      .toEqual([renamed, third, fourth, ...trailingFolders]);

    await folderRow(page, fifth).click({ button: "right" });
    await expect(menu).toBeVisible();
    const otherId = await page.evaluate(async (root) => {
      const fixture = await import("/tests/workspace-folder-edit.fixture.ts");
      const other = fixture.createWorkspace([root]);
      fixture.selectWorkspace(other);
      return other;
    }, root);
    await expect(menu).toBeHidden();
    await page.evaluate(async ({ id, otherId }) => {
      const fixture = await import("/tests/workspace-folder-edit.fixture.ts");
      fixture.removeWorkspace(otherId);
      fixture.selectWorkspace(id);
    }, { id: workspaceId, otherId });

    await folderRow(page, third).press("F2");
    await editor.fill(first);
    await folderRow(peer, third).click({ button: "right" });
    await peer.getByRole("menuitem", { name: "Remove Folder", exact: true }).click();
    await expect
      .poll(() => workspaceFolders(page, workspaceId))
      .toEqual([renamed, fourth, ...trailingFolders]);
    await expect(editor).toHaveCount(0);

    const selected = folderRow(page, fourth);
    await selected.focus();
    await expect(selected).toHaveClass(/\bselected\b/);
    await folderRow(peer, renamed).press("Delete");
    await expect(folderRow(page, renamed)).toHaveCount(0);
    await expect(selected).toBeFocused();
    await expect(selected).toHaveClass(/\bselected\b/);
    await page.keyboard.press("Delete");
    await expect.poll(() => workspaceFolders(peer, workspaceId)).toEqual(trailingFolders);

    await folderRow(page, duplicate).first().press("F2");
    await editor.fill(second);
    const peerEditor = peer.getByRole("textbox", { name: "Edit folder path" });
    await folderRow(peer, duplicate).first().press("F2");
    await peerEditor.fill(third);
    await peerEditor.press("Enter");
    await expect.poll(() => workspaceFolders(page, workspaceId)).toEqual([fifth, third, duplicate]);
    await expect(editor).toHaveCount(0);
    await page.keyboard.press("Enter");
    expect(await workspaceFolders(page, workspaceId)).toEqual([fifth, third, duplicate]);
  } finally {
    if (id !== undefined) {
      await page.evaluate(
        async (id) => (await import("/tests/workspace-folder-edit.fixture.ts")).removeWorkspace(id),
        id,
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});
