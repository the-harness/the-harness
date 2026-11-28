import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("tab context actions target the clicked tab and support keyboard dismissal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  const chatTab = page.getByRole("tab", { name: "Chat", exact: true });
  const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await chatTab.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Editor tab actions", exact: true });
  await menu.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(chatTab).toHaveCount(0);
  await expect(settingsTab).toBeVisible();
  await settingsTab.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(settingsTab).toBeFocused();

  const header = settingsTab.locator("xpath=ancestor::div[contains(@class, 'dv-tabs-and-actions-container')]");
  await header.click({ button: "right", position: { x: (await header.boundingBox())!.width - 4, y: 5 } });
  await expect(menu.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settingsTab).toBeFocused();
});

test("tabs show icons and close controls before hovering, including inactive tabs", async ({
  page,
}, testInfo) => {
  const openSettingsInEditor = async () => {
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  };
  const root = testInfo.outputPath("tabs-workspace");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"tabs-fixture"}');
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const workspace = await page.evaluate(
    async (root) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
    root,
  );
  await page
    .getByRole("tree", { name: "Explorer", exact: true })
    .getByRole("treeitem", { name: "package.json", exact: true })
    .click();
  await openSettingsInEditor();
  await page.mouse.move(5, 5);

  for (const title of ["Chat", "package.json", "Settings"]) {
    const tab = page.getByRole("tab", { name: title, exact: true });
    const icon = tab.locator(".workbench-tab-icon");
    const close = tab.getByRole("button", { name: `Close ${title}`, exact: true });
    await expect(icon).toBeVisible();
    await expect
      .poll(() => icon.evaluate((element) => getComputedStyle(element).maskImage))
      .not.toBe("none");
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS("opacity", "1");
  }

  await page.getByRole("button", { name: "Close package.json", exact: true }).click();
  await expect(page.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
  await openSettingsInEditor();
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }).locator(".workbench-tab-icon"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Settings", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Close Chat", exact: true }).click();
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await openSettingsInEditor();
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }).locator(".workbench-tab-icon"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Files", exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Settings", exact: true }).click({ button: "middle" });
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
  await page.evaluate(
    async (workspace) =>
      (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace),
    workspace,
  );
});

test("command palette highlights query matches, renders keybinding badges, and executes commands", async ({
  page,
}) => {
  const shell = {
    id: "tabs-shell",
    title: "Tabs shell",
    cwd: "/workspace",
    pid: 1,
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  };
  await page.route("**/api/terminals", (route) => route.fulfill({ json: [shell] }));
  await page.routeWebSocket("**/ws/terminals/*", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", info: shell, data: "Terminal ready\r\n" }));
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search commands", exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill(">Terminal");
  const option = page.getByRole("option", { name: /Layout: Toggle Terminal/ });
  await expect(option).toBeVisible();
  await expect(option.locator(".highlight")).toHaveText("Terminal");
  await expect(option.locator(".command-key").first()).toBeVisible();

  await input.press("Enter");
  await expect(input).toHaveCount(0);
  const terminal = page.getByRole("heading", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  const bottom = page.getByRole("button", { name: "Toggle bottom panel" });
  await expect(bottom).toHaveAttribute("aria-pressed", "true");
  await bottom.click();
  await expect(terminal).toBeHidden();

  await page.keyboard.press("ControlOrMeta+k");
  await input.fill(">New conversation");
  await input.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "New conversation", exact: true })).toHaveCount(0);
});

test("dragging a single tab in a group onto its own group edge does not split or show drop overlay", async ({
  page,
}) => {
  await page.goto("/");
  const chatTab = page.getByRole("tab", { name: "Chat", exact: true });
  await expect(chatTab).toBeVisible();

  const groups = page.locator(".dv-groupview");
  const initialGroupCount = await groups.count();
  const chatGroup = chatTab.locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]");
  const groupBox = await chatGroup.boundingBox();
  if (!groupBox) throw new Error("Missing bounding box");

  const target = chatGroup.locator(".dv-content-container");
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("Missing content container bounding box");

  await page.evaluate(() => {
    (window as unknown as { __dropzoneSeen: boolean }).__dropzoneSeen = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".dv-drop-target-dropzone")) {
        (window as unknown as { __dropzoneSeen: boolean }).__dropzoneSeen = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await chatTab.dragTo(target, {
    targetPosition: { x: targetBox.width / 2, y: targetBox.height - 12 },
  });

  const dropzoneSeen = await page.evaluate(
    () => (window as unknown as { __dropzoneSeen: boolean }).__dropzoneSeen,
  );
  expect(dropzoneSeen).toBe(false);

  await expect(groups).toHaveCount(initialGroupCount);
});
