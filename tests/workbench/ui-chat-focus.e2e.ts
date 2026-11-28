import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function newConversation(page: Page, title: string) {
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const row = tree.getByRole("treeitem", { name: /^New conversation\b/, selected: true });
  await expect(row).toBeVisible();
  await row.click();
  await tree.press("F2");
  const rename = tree.getByRole("textbox", { name: "Conversation title", exact: true });
  await rename.fill(title);
  await rename.press("Enter");
  await expect(
    tree.getByRole("treeitem", { name: new RegExp(`^${title}\\b`), selected: true }),
  ).toBeVisible();
}

test("switching conversations preserves composer focus and keyboard browsing in the tree", async ({
  page,
}) => {
  await page.goto("/");
  await newConversation(page, "First focus conversation");
  await newConversation(page, "Second focus conversation");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await composer.click();
  await page.evaluate(() => {
    const events: string[] = [];
    (window as Window & { focusEvents?: string[] }).focusEvents = events;
    document.addEventListener("focusin", (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      events.push(event.target.getAttribute("aria-label") ?? event.target.tagName);
    });
  });
  await tree.getByRole("treeitem", { name: /^First focus conversation\b/ }).click();
  await expect(
    page.getByRole("heading", { name: "First focus conversation", exact: true }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(() => (window as Window & { focusEvents?: string[] }).focusEvents),
  ).toEqual([]);
  await page.keyboard.type("First conversation draft");
  await expect(composer).toHaveValue("First conversation draft");

  await tree.focus();
  await page.evaluate(() => {
    (window as Window & { focusEvents: string[] }).focusEvents.length = 0;
  });
  await page.keyboard.press("ArrowUp");
  const second = tree.getByRole("treeitem", { name: /^Second focus conversation\b/ });
  await expect(tree).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);
  await expect(tree).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "First focus conversation", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as Window & { focusEvents?: string[] }).focusEvents),
  ).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Second focus conversation", exact: true }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(() => (window as Window & { focusEvents?: string[] }).focusEvents),
  ).toEqual(["Message Harness"]);
  await page.keyboard.type("Second conversation draft");
  await expect(composer).toHaveValue("Second conversation draft");

  await page.evaluate(() => {
    (window as Window & { focusEvents: string[] }).focusEvents.length = 0;
  });
  await tree.getByRole("treeitem", { name: /^First focus conversation\b/ }).click();
  await expect(composer).toHaveValue("First conversation draft");
  await expect(composer).toBeFocused();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(() => (window as Window & { focusEvents?: string[] }).focusEvents),
  ).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`conversation selection keeps its focused appearance while typing in ${theme} theme`, async ({
    page,
  }) => {
    await page.goto("/");
    if (theme === "light") {
      await page.getByRole("button", { name: "Manage", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await page.getByRole("combobox", { name: "Color theme", exact: true }).click();
      await page.getByRole("option", { name: "Light 2026", exact: true }).click();
      await page.keyboard.press("Escape");
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const firstTitle = `First ${theme} selection`;
    const secondTitle = `Second ${theme} selection`;
    await newConversation(page, firstTitle);
    await newConversation(page, secondTitle);
    const tree = page.getByRole("tree", { name: "Conversations", exact: true });
    const first = tree.getByRole("treeitem", { name: new RegExp(`^${firstTitle}\\b`) });
    const second = tree.getByRole("treeitem", { name: new RegExp(`^${secondTitle}\\b`) });
    const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
    await expect(tree).toBeFocused();
    await expect(second).toHaveCSS("outline-style", "solid");
    await expect(second).toHaveCSS("outline-width", "1px");
    const baseline = await second.evaluate((row) => {
      const style = getComputedStyle(row);
      return {
        background: style.backgroundColor,
        outline: style.outline,
        offset: style.outlineOffset,
      };
    });
    await page.evaluate(() => {
      const state = window as typeof window & { sessionSelectionFrames: unknown[] };
      state.sessionSelectionFrames = [];
      document.addEventListener("focusin", (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          event.target.getAttribute("aria-label") !== "Message Harness"
        )
          return;
        const row = document.querySelector(
          '[role="tree"][aria-label="Conversations"] [aria-selected="true"]',
        );
        if (!row) return;
        const sample = () => {
          const style = getComputedStyle(row);
          state.sessionSelectionFrames.push({
            id: row.getAttribute("id"),
            background: style.backgroundColor,
            outline: style.outline,
            offset: style.outlineOffset,
          });
        };
        sample();
        requestAnimationFrame(() => {
          sample();
          requestAnimationFrame(sample);
        });
      });
    });
    await composer.click();
    await expect(composer).toBeFocused();
    const secondFrame = { id: await second.getAttribute("id"), ...baseline };
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { sessionSelectionFrames: unknown[] })
              .sessionSelectionFrames,
        ),
      )
      .toEqual([secondFrame, secondFrame, secondFrame]);

    await page.evaluate(() => {
      (window as typeof window & { sessionSelectionFrames: unknown[] }).sessionSelectionFrames = [];
    });
    const border = await composer.evaluate(
      (input) => getComputedStyle(input.closest(".composer")!).borderColor,
    );
    const bounds = (await first.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    const heldFrames = await composer.evaluate(async (input) => {
      const frames = [];
      for (let frame = 0; frame < 2; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const row = document.querySelector(
          '[role="tree"][aria-label="Conversations"] [aria-selected="true"]',
        )!;
        const style = getComputedStyle(row);
        frames.push({
          focused: document.activeElement === input,
          border: getComputedStyle(input.closest(".composer")!).borderColor,
          id: row.getAttribute("id"),
          background: style.backgroundColor,
          outline: style.outline,
          offset: style.outlineOffset,
        });
      }
      return frames;
    });
    const heldFrame = { focused: true, border, ...secondFrame };
    await page.mouse.up();
    expect(heldFrames).toEqual([heldFrame, heldFrame]);
    await expect(page.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(first).toHaveCSS("background-color", baseline.background);
    await expect(first).toHaveCSS("outline", baseline.outline);
    await expect(page.locator(".composer")).toHaveCSS("border-color", border);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { sessionSelectionFrames: unknown[] }).sessionSelectionFrames,
      ),
    ).toEqual([]);
    await page.keyboard.type("Typing without a selection flash");
    await expect(composer).toHaveValue("Typing without a selection flash");

    await first.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in new tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: firstTitle, exact: true })).toBeVisible();
    await composer.click();
    await expect(composer).toBeFocused();
    await expect(first).toHaveCSS("outline", baseline.outline);
    await expect(first).toHaveCSS("background-color", baseline.background);
    const chatTab = page.getByRole("tab", { name: firstTitle, exact: true });
    await chatTab.focus();
    await expect(chatTab).toBeFocused();
    await expect(first).toHaveCSS("outline", baseline.outline);
    await expect(first).toHaveCSS("background-color", baseline.background);

    await tree.focus();
    await page.keyboard.press("ArrowUp");
    await expect(tree).toBeFocused();
    await expect(tree).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);
    await expect(first).toHaveCSS("outline-style", "none");
    await expect(second).toHaveCSS("outline", baseline.outline);
    expect(
      await tree
        .getByRole("treeitem")
        .evaluateAll((rows) =>
          rows.filter((row) => getComputedStyle(row).outlineStyle !== "none").map((row) => row.id),
        ),
    ).toEqual([await second.getAttribute("id")]);

    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "Search settings", exact: true }),
    ).toBeFocused();
    await expect(first).toHaveCSS("outline-style", "none");
    await expect(second).toHaveCSS("outline-style", "none");
    await expect(first).not.toHaveCSS("background-color", baseline.background);
  });
}

test("explicit new conversation focuses its composer from the tree and command palette", async ({
  page,
}) => {
  await page.goto("/");
  await newConversation(page, "New conversation focus origin");
  const tree = page.getByRole("tree", { name: "Conversations", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await tree.press("ControlOrMeta+n");
  await expect(composer).toBeFocused();
  await composer.fill("draft remains in its conversation");
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(">New conversation");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
});

test("new conversation from a workspace editor focuses the newly opened chat", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("workspace-focus");
  await mkdir(root, { recursive: true });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const workspace = await page.evaluate(
    async (root) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
    root,
  );
  try {
    await page
      .getByRole("tree", { name: "Conversations", exact: true })
      .getByRole("treeitem", { name: "New workspace, has actions", exact: true })
      .click();
    await page.getByRole("button", { name: "New conversation in workspace", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message Harness", exact: true })).toBeFocused();
  } finally {
    await page.evaluate(
      async (workspace) =>
        (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace),
      workspace,
    );
  }
});

test("moving Settings into an editor continues in the editor search instead of returning to Manage", async ({
  page,
}) => {
  await page.goto("/");
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  await manage.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    dialog.getByRole("searchbox", { name: "Search settings", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Open Settings in Editor", exact: true }).click();
  await expect(dialog).toBeHidden();
  const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.type("activity bar");
  await expect(search).toHaveValue("activity bar");
});

test("a queued message consumed in the background does not take focus back from another control", async ({
  page,
}) => {
  await page.route("**/chat-queue-focus-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto("/chat-queue-focus-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-queue-drag-ownership.fixture.ts")).mountChat(),
  );
  await page
    .getByRole("button", { name: "Edit queued message 1: First prompt 1", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
  const preset = page.getByRole("button", { name: "Select agent preset", exact: true });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("First prompt 1");
  await composer.press("Shift+Tab");
  await expect(preset).toBeFocused();
  await page.evaluate(async () =>
    (await import("/tests/chat-queue-drag-ownership.fixture.ts")).consumeFirstQueuedMessage(),
  );
  await expect(page.locator(".pending-text")).toHaveText(["First prompt 2"]);
  await expect(composer).toHaveValue("");
  await expect(preset).toBeFocused();

  await page
    .getByRole("button", { name: "Edit queued message 1: First prompt 2", exact: true })
    .click();
  await expect(composer).toBeFocused();
  await page.evaluate(async () =>
    (await import("/tests/chat-queue-drag-ownership.fixture.ts")).consumeFirstQueuedMessage(),
  );
  await expect(page.locator(".pending-item")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
});
