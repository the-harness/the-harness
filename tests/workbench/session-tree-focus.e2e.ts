import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function createConversation(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const selected = tree.getByRole("treeitem", { selected: true });
  await expect(selected).toBeVisible();
  const id = await selected.getAttribute("data-id");
  return { tree, row: tree.locator(`[data-id="${id}"]`) };
}

test("conversation rename keeps IME Enter and Escape inside the focused editor", async ({
  page,
}) => {
  const { tree, row } = await createConversation(page);
  await row.click();
  await tree.press("F2");
  const rename = row.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(rename).toBeFocused();
  await rename.fill("输入中的会话标题");
  await rename.dispatchEvent("compositionstart");
  await rename.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue("输入中的会话标题");
  await rename.dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: true });
  await expect(rename).toBeFocused();
  await rename.dispatchEvent("compositionend");
  await rename.press("Enter");
  await expect(rename).toHaveCount(0);
  await expect(row).toHaveAccessibleName(/^输入中的会话标题/);
  await expect(tree).toBeFocused();
});

test("leaving conversation rename commits without stealing focus from the composer", async ({
  page,
}) => {
  const { tree, row } = await createConversation(page);
  await row.click();
  await tree.press("F2");
  const rename = row.getByRole("textbox", { name: "Conversation title", exact: true });
  await rename.fill("Renamed without focus theft");
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await page.evaluate(() => {
    const trace: string[] = [];
    (window as unknown as { renameFocusTrace: string[] }).renameFocusTrace = trace;
    document.addEventListener("focusin", (event) => {
      const target = event.target as HTMLElement;
      trace.push(
        target.getAttribute("aria-label") ?? target.getAttribute("role") ?? target.tagName,
      );
    });
  });
  await composer.click();
  await expect(rename).toHaveCount(0);
  await expect(row).toHaveAccessibleName(/^Renamed without focus theft\b/);
  await expect(composer).toBeFocused();
  await page.keyboard.type("Keep typing here");
  await expect(composer).toHaveValue("Keep typing here");
  await expect(composer).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { renameFocusTrace: string[] }).renameFocusTrace,
    ),
  ).toEqual(["Message Harness"]);
});

test("conversation context menu dismissal retains the clicked row and restores tree focus", async ({
  page,
}) => {
  const { tree, row } = await createConversation(page);
  await page.getByRole("textbox", { name: "Message Harness", exact: true }).click();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for New conversation", exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(tree).toBeFocused();
  await expect(tree).toHaveAttribute("aria-activedescendant", (await row.getAttribute("id"))!);
});

test("workspace selection keeps tree focus while its new-conversation action focuses the composer", async ({
  page,
}, testInfo) => {
  const folder = testInfo.outputPath("focus-workspace");
  await mkdir(folder, { recursive: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder as workspace", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Open Folder as Workspace", exact: true });
  await expect(picker.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
  await picker.getByRole("combobox", { name: "Path", exact: true }).fill(folder);
  await picker.getByRole("option", { name: "focus-workspace", exact: true }).click();
  await picker.getByRole("button", { name: "Open Folder", exact: true }).click();
  await expect(picker).toBeHidden();

  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const workspace = tree.getByRole("treeitem", { name: /^focus-workspace,/ }).last();
  const add = workspace.getByRole("button", { name: "New conversation here", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await add.click();
  await expect(composer).toBeFocused();

  await page.evaluate(() => {
    const state = window as typeof window & { sessionTreeFocus: string[] };
    state.sessionTreeFocus = [];
    document.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLElement) {
        state.sessionTreeFocus.push(event.target.getAttribute("role") ?? event.target.tagName);
      }
    });
  });
  await workspace.locator(".vc-tree-label").click();
  await expect(page.getByRole("tab", { name: "focus-workspace", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tree).toBeFocused();
  const focused = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return (window as typeof window & { sessionTreeFocus: string[] }).sessionTreeFocus;
  });
  expect(focused).toEqual(["tree"]);

  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await composer.click();
  await expect(workspace).toHaveAttribute("aria-selected", "true");
  await expect(workspace).toHaveCSS("outline-style", "none");

  await add.click();
  await expect(composer).toBeFocused();
  await composer.fill("A new conversation starts here");
  await expect(composer).toHaveValue("A new conversation starts here");
});
