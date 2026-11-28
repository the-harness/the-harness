import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("switching file tabs shows progress only for slow reads and keeps loaded text", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("editor-loading");
  const first = "first.txt";
  const second = "second.txt";
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, first), "first-content"),
    writeFile(join(root, second), "second-content"),
  ]);

  const slowOpen = Promise.withResolvers<void>();
  const slowReload = Promise.withResolvers<void>();
  const reads: string[] = [];
  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const { type, path, body } = JSON.parse(raw.toString());
        if (type === "request" && path === "/rpc/workspace.readFile" && body?.root === root) {
          const name = body.relativePath as string;
          const isReload = reads.includes(name);
          reads.push(name);
          const hold = name === second ? slowOpen : isReload ? slowReload : undefined;
          if (hold) {
            void hold.promise.then(() => server.send(raw));
            return;
          }
        }
        server.send(raw);
      });
    },
  );

  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  const workspace = await page.evaluate(
    async (root) =>
      (await import("/tests/workbench-workspace.fixture.ts")).createFileWorkspace(root),
    root,
  );

  try {
    const explorer = page.getByRole("tree", { name: "Explorer", exact: true });
    const row = (name: string) => explorer.getByRole("treeitem", { name, exact: true });
    const tab = (name: string) => page.getByRole("tab", { name, exact: true });
    const lines = page.locator(".file-editor-monaco:visible .view-lines");
    const progress = page.getByRole("progressbar", { name: "Loading file", exact: true });
    await expect(row(first)).toBeVisible();

    const feedbackSeen = await page.evaluateHandle(() => {
      const placeholder = ".file-editor-placeholder";
      const progressBar = '[role="progressbar"][aria-label="Loading file"]';
      const selector = `${placeholder}, ${progressBar}`;
      const seen = { text: false, progress: false };
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            for (const element of [node, ...node.querySelectorAll(selector)]) {
              if (
                element.matches(placeholder) &&
                element.textContent?.trim().startsWith("Loading ")
              ) {
                seen.text = true;
              }
              if (element.matches(progressBar) && element.getClientRects().length) {
                seen.progress = true;
              }
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      return seen;
    });

    await row(first).click();
    await expect(lines).toHaveText("first-content");
    await expect(progress).toHaveCount(0);
    expect((await feedbackSeen.jsonValue()).text).toBe(false);
    expect(reads).toEqual([first]);
    const firstEditor = await page
      .getByRole("tabpanel", { name: first, exact: true })
      .locator(".file-editor-monaco .monaco-editor")
      .elementHandle();
    const inlineSize = (element: Element) => {
      const { width, height } = (element as HTMLElement).style;
      return [width, height];
    };
    const firstSize = await firstEditor.evaluate(inlineSize);
    expect(firstSize.every((size) => Number.parseFloat(size) > 0)).toBe(true);

    await row(second).click();
    await expect(progress).toBeVisible();
    expect(reads).toEqual([first, second]);
    expect((await feedbackSeen.jsonValue()).text).toBe(false);
    expect(await firstEditor.evaluate(inlineSize)).toEqual(firstSize);

    const loadingEditor = page
      .getByRole("tabpanel", { name: second, exact: true })
      .locator(".file-editor-monaco .monaco-editor");
    await expect(loadingEditor).toBeVisible();
    const loadingSize = await loadingEditor.evaluate((editor) => ({
      host: [editor.parentElement?.clientWidth, editor.parentElement?.clientHeight],
      editor: [editor.clientWidth, editor.clientHeight],
    }));
    expect(loadingSize.editor[0]).toBeGreaterThan(0);
    expect(loadingSize.editor[1]).toBeGreaterThan(0);
    expect(loadingSize.editor).toEqual(loadingSize.host);

    await loadingEditor.getByRole("textbox").focus();
    await page.keyboard.insertText("ignored-during-load");
    await expect(loadingEditor.locator(".view-lines")).not.toContainText("ignored-during-load");
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
    slowOpen.resolve();
    await expect(lines).toHaveText("second-content");
    await expect(progress).toHaveCount(0);

    const viewport = page.viewportSize()!;
    await page.setViewportSize({ ...viewport, height: viewport.height - 120 });
    await expect
      .poll(() =>
        loadingEditor.evaluate((editor, oldHeight) => {
          const height = editor.parentElement?.clientHeight ?? 0;
          return height > 0 && height !== oldHeight && editor.clientHeight === height;
        }, loadingSize.editor[1]),
      )
      .toBe(true);

    await feedbackSeen.evaluate((seen) => (seen.progress = false));
    const firstTab = tab(first);
    const firstActiveFrame = await firstTab.evaluateHandle((target) => ({
      frame: new Promise<{ host: number[]; editor: number[] }>((resolve) => {
        const sample = () => {
          if (target.getAttribute("aria-selected") !== "true") {
            requestAnimationFrame(sample);
            return;
          }
          const panel = document.getElementById(target.getAttribute("aria-controls") ?? "");
          const host = panel?.querySelector<HTMLElement>(".file-editor-monaco");
          const editor = host?.querySelector<HTMLElement>(".monaco-editor");
          resolve({
            host: [host?.clientWidth ?? 0, host?.clientHeight ?? 0],
            editor: [editor?.clientWidth ?? 0, editor?.clientHeight ?? 0],
          });
        };
        target.addEventListener("click", () => requestAnimationFrame(sample), { once: true });
      }),
    }));
    await firstTab.click();
    const frame = await firstActiveFrame.evaluate(({ frame }) => frame);
    expect(frame.host[0]).toBeGreaterThan(0);
    expect(frame.host[1]).toBeGreaterThan(0);
    expect(frame.editor).toEqual(frame.host);
    await expect(lines).toHaveText("first-content");
    await tab(second).click();
    await expect(lines).toHaveText("second-content");
    expect(await feedbackSeen.jsonValue()).toEqual({ text: false, progress: false });
    expect(reads).toEqual([first, second]);

    await page.evaluate(
      async (path) => {
        (await import("/tests/workbench-workspace.fixture.ts")).reloadFile(path);
      },
      join(root, first),
    );
    await expect.poll(() => reads).toEqual([first, second, first]);
    await tab(first).click();
    await expect(progress).toBeVisible();
    await expect(lines).toHaveText("first-content");
    slowReload.resolve();
    await expect(progress).toHaveCount(0);
    await expect(lines).toHaveText("first-content");
    expect(await feedbackSeen.jsonValue()).toEqual({ text: false, progress: true });
  } finally {
    slowOpen.resolve();
    slowReload.resolve();
    await page.evaluate(async (workspace) => {
      (await import("/tests/workbench-workspace.fixture.ts")).removeFileWorkspace(workspace);
    }, workspace);
  }
});
