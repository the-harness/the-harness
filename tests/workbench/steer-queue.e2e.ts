import { expect, test, type Page } from "@playwright/test";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYfcAAAAASUVORK5CYII=",
  "base64",
);

async function openChat(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  const input = page.getByRole("textbox", { name: "Message Harness", exact: true });
  await expect(input).toBeVisible();
  return input;
}

test("keeps identical user messages separate across queue, steer area, and live editing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const input = await openChat(page);
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const queue = page.getByRole("button", { name: "Queue message", exact: true });
  const stop = page.getByRole("button", { name: "Stop response", exact: true });
  const resume = page.getByRole("button", { name: "Resume queue", exact: true });
  const rightmostAction = page.locator(".composer-toolbar").getByRole("button").last();

  await expect(send).toBeDisabled();
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("\n");
  await input.fill("Start task");
  await send.click();
  await expect(queue).toHaveCount(0);
  await expect(rightmostAction).toHaveAccessibleName("Stop response");
  const rightEdge = await stop.evaluate((element) => element.getBoundingClientRect().right);

  await input.fill("same content");
  await expect(rightmostAction).toHaveAccessibleName("Queue message");
  await expect(queue.locator("svg")).toBeVisible();
  expect(await queue.evaluate((element) => element.getBoundingClientRect().right)).toBeCloseTo(
    rightEdge,
    0,
  );
  expect(await stop.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThan(
    rightEdge,
  );

  await input.clear();
  await expect(queue).toHaveCount(0);
  await expect(rightmostAction).toHaveAccessibleName("Stop response");
  expect(await stop.evaluate((element) => element.getBoundingClientRect().right)).toBeCloseTo(
    rightEdge,
    0,
  );

  await input.fill("same content");
  await input.press("Enter");
  await input.fill("same content");
  await queue.click();

  const pendingText = page.locator(".pending-item.is-pending-turn .pending-text");
  const queuedText = page.locator(".pending-item.is-queued-turn .pending-text");
  await expect(queuedText).toHaveText(["same content", "same content"]);

  await stop.click();
  await expect(input).toBeFocused();
  await expect(resume).toBeEnabled();

  await input.fill("same content");
  await queue.click();
  await expect(queuedText).toHaveText(["same content", "same content", "same content"]);

  await input.fill("direct steer");
  await input.press("ControlOrMeta+Enter");

  await input.fill("steer dup");
  await input.press("ControlOrMeta+Enter");
  await input.fill("steer dup");
  await input.press("ControlOrMeta+Enter");

  await expect(pendingText.filter({ hasText: /^steer dup$/ })).toHaveCount(2);
  await expect(queuedText).toHaveText(["same content", "same content", "same content"]);
  await expect(page.locator(".composer-area").getByRole("button", { name: /^Steer / })).toHaveCount(
    0,
  );

  await input.fill("unsent draft");
  const edit = page.getByRole("button", { name: /^Edit queued message 2:/ });
  const editedRow = page.locator(".pending-item").filter({ has: edit });
  await edit.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("same content");
  await edit.click();
  await expect(editedRow).toHaveClass(/editing/);
  await input.fill("edited middle item");
  await expect(queuedText).toHaveText(["same content", "edited middle item", "same content"]);
  await expect(stop).toBeVisible();
  const done = page.getByRole("button", { name: "Finish editing", exact: true });
  await expect(done).toHaveText("Done");
  await expect(rightmostAction).toHaveAccessibleName("Finish editing");

  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  const commands = page.getByRole("combobox", { name: "Search commands", exact: true });
  await expect(commands).toBeFocused();
  await commands.press("Escape");
  await expect(done).toHaveCount(0);
  await expect(input).toHaveValue("unsent draft");
  await expect(queuedText).toHaveText(["same content", "edited middle item", "same content"]);

  const queuedRows = page.locator(".pending-item.is-queued-turn");
  const grip = await editedRow.locator(".pending-grip").boundingBox();
  const firstRow = await queuedRows.first().boundingBox();
  if (!grip || !firstRow) throw new Error("Queued drag controls are not visible");
  const x = grip.x + grip.width / 2;
  await page.mouse.move(x, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, firstRow.y + firstRow.height / 4, { steps: 5 });
  await page.mouse.up();
  await expect(queuedText).toHaveText(["edited middle item", "same content", "same content"]);
  await expect(done).toHaveCount(0);
  await expect(input).toHaveValue("unsent draft");

  const rowToRemove = queuedRows.filter({ hasText: "edited middle item" });
  await rowToRemove.hover();
  const remove = rowToRemove.getByRole("button", { name: "Remove queued message 1", exact: true });
  await expect(remove.locator(".i-codicon-trash")).toBeVisible();
  await remove.click();
  await expect(queuedText).toHaveText(["same content", "same content"]);
  await expect(done).toHaveCount(0);
  await expect(input).toHaveValue("unsent draft");

  await stop.click();
  await input.clear();
  await resume.click();
  await expect(stop).toBeVisible();
  expect(errors).toEqual([]);
});

test("restores uploaded draft images and keeps queue editing isolated across sessions", async ({
  page,
}) => {
  const input = await openChat(page);
  const firstId = await page.evaluate(async () =>
    (await import("/tests/composer-draft.fixture.ts")).currentSessionId(),
  );
  const fileInput = page.locator('.composer input[type="file"]');
  const removeImage = page.getByRole("button", { name: "Remove draft.png", exact: true });
  const draftImage = page.getByRole("img", { name: "draft.png", exact: true });
  const stop = page.getByRole("button", { name: "Stop response", exact: true });
  const queuedText = page.locator(".pending-item.is-queued-turn .pending-text");

  await input.fill("Start first conversation");
  await input.press("Enter");
  await expect(stop).toBeVisible();
  await input.fill("Queued first message");
  await input.press("Enter");
  await expect(queuedText).toHaveText("Queued first message");
  await stop.click();
  await input.fill("Unsent first draft");
  await fileInput.setInputFiles({
    name: "draft.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.locator(".composer-image-item.is-ready")).toBeVisible();
  const imageWidth = () => draftImage.evaluate((img) => (img as HTMLImageElement).naturalWidth);
  await expect.poll(imageWidth).toBe(1);

  await page.locator(".pending-item.is-queued-turn").hover();
  await page
    .getByRole("button", { name: "Edit queued message 1: Queued first message", exact: true })
    .click();
  await expect(removeImage).toHaveCount(0);
  await input.fill("Edited queued message");
  await expect(queuedText).toHaveText("Edited queued message");
  await fileInput.setInputFiles({
    name: "empty.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeDisabled();

  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("list", { name: "Attached images", exact: true })).toHaveCount(0);
  const secondId = await page.evaluate(async () =>
    (await import("/tests/composer-draft.fixture.ts")).currentSessionId(),
  );
  await input.fill("Unsent second draft");
  const selectSession = (id: string) =>
    page.evaluate(
      async (id) => (await import("/tests/composer-draft.fixture.ts")).selectSession(id),
      id,
    );
  await selectSession(firstId);
  await expect(input).toHaveValue("Unsent first draft");
  await expect(removeImage).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(
        (id) => localStorage.getItem(`harness:session:${id}:core:ui-chat:draft`),
        firstId,
      ),
    )
    .toContain("draft.png");
  await page.reload();
  await expect(input).toHaveValue("Unsent first draft");
  await expect.poll(imageWidth).toBe(1);
  await removeImage.click();
  await expect(removeImage).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => localStorage.getItem(`harness:session:${id}:core:ui-chat:draft`),
        firstId,
      ),
    )
    .not.toContain("draft.png");
  await page.reload();
  await expect(input).toHaveValue("Unsent first draft");
  await expect(removeImage).toHaveCount(0);
  await selectSession(secondId);
  await expect(input).toHaveValue("Unsent second draft");
  await expect(removeImage).toHaveCount(0);
});

test("restores draft text when a saved image is missing and lets the user remove it", async ({
  page,
}) => {
  const input = await openChat(page);
  const key = await page.evaluate(async () => {
    const id = (await import("/tests/composer-draft.fixture.ts")).currentSessionId();
    const key = `harness:session:${id}:core:ui-chat:draft`;
    localStorage.setItem(
      key,
      JSON.stringify({
        text: "keep my text",
        images: [{ fileId: `${"d".repeat(64)}.png`, mimeType: "image/png", filename: "lost.png" }],
      }),
    );
    return key;
  });
  await page.reload();
  await expect(input).toHaveValue("keep my text");
  await expect(
    page.getByRole("status").filter({ hasText: "A saved image is unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove lost.png", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key))
    .toEqual({ text: "keep my text", images: [] });
});

test("preserves the draft when an image upload fails", async ({ page }) => {
  const input = await openChat(page);
  const fileInput = page.locator('.composer input[type="file"]');
  const invalidImage = { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) };
  const failedUpload = page.getByText("Retry or remove failed images.", { exact: true });
  const remove = page.getByRole("button", { name: "Remove empty.png", exact: true });
  const draft = "Keep this draft";

  await input.fill(draft);
  await fileInput.setInputFiles(invalidImage);
  await expect(failedUpload).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await input.press("Enter");
  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveValue(draft);
  await expect(remove).toBeVisible();

  await remove.click();
  await expect(failedUpload).toBeHidden();
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();

  const queue = page.getByRole("button", { name: "Queue message", exact: true });
  const rightmostAction = page.locator(".composer-toolbar").getByRole("button").last();
  await expect(queue).toHaveCount(0);
  await expect(rightmostAction).toHaveAccessibleName("Stop response");
  await fileInput.setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(input).toHaveValue("");
  await expect(rightmostAction).toHaveAccessibleName("Queue message");
  await expect(queue).toBeEnabled();
  await page.getByRole("button", { name: "Remove pixel.png", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await expect(rightmostAction).toHaveAccessibleName("Stop response");

  const followUp = "Keep this follow-up";
  await input.fill(followUp);
  await fileInput.setInputFiles(invalidImage);
  await expect(failedUpload).toBeVisible();
  await expect(queue).toBeDisabled();
  await input.press("Enter");
  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveValue(followUp);

  await remove.click();
  await expect(queue).toBeEnabled();

  await queue.click();
  const queuedRow = page.locator(".pending-item.is-queued-turn");
  await queuedRow.getByRole("button", { name: /^Edit queued message 1:/ }).click();
  await expect(input).toBeFocused();
  await fileInput.setInputFiles(invalidImage);
  await expect(failedUpload).toBeVisible();
  const done = page.getByRole("button", { name: "Finish editing", exact: true });
  await expect(done).toBeDisabled();
  await page.locator(".chat-heading h1").click();
  await expect(failedUpload).toBeVisible();
  await expect(done).toBeDisabled();
  await input.press("Enter");
  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveValue(followUp);
  await remove.click();
  await done.click();
  await expect(input).toHaveValue("");
});

test("waits for the configured model before the server starts the run", async ({ page }) => {
  const modelsRequested = Promise.withResolvers<void>();
  const releaseModels = Promise.withResolvers<void>();
  const model = { id: "mock", name: "Mock", provider: "mock" };
  const startedModels: unknown[] = [];

  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      const server = socket.connectToServer();
      socket.onMessage(async (raw) => {
        const frame = JSON.parse(raw.toString());
        if (
          frame.type === "request" &&
          frame.path === "/rpc/chat.listModels" &&
          frame.scope[0] === "session"
        ) {
          modelsRequested.resolve();
          await releaseModels.promise;
          socket.send(
            JSON.stringify({ type: "response", id: frame.id, ok: true, result: [model] }),
          );
          return;
        }
        if (frame.type === "request" && frame.path === "/rpc/chat.start") {
          startedModels.push(frame.body?.modelId);
        }
        server.send(raw);
      });
    },
  );

  const input = await openChat(page);
  await modelsRequested.promise;
  const stop = page.getByRole("button", { name: "Stop response", exact: true });
  const assistant = page.locator("article.assistant");
  try {
    await input.fill("Start immediately");
    await input.press("Enter");
    await expect(page.locator(".pending-item.is-pending-turn .pending-text")).toHaveText([
      "Start immediately",
    ]);
    expect(startedModels).toEqual([]);
  } finally {
    releaseModels.resolve();
  }

  await expect(assistant).toHaveText("Processed: Start immediately");
  expect(startedModels).toEqual([model.id]);
  await expect(page.locator("article.user")).toHaveCount(1);
  await stop.click();
  await expect(stop).toHaveCount(0);
});

test("gives a long queue room and keeps the composer visible in a short pane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await openChat(page);
  const chat = page.locator(".chat-panel");
  const queueList = chat.locator(".pending-queue-list");
  const queuedRows = queueList.locator(".pending-item.is-queued-turn");
  const stop = chat.getByRole("button", { name: "Stop response", exact: true });
  const queue = chat.getByRole("button", { name: "Queue message", exact: true });

  await input.fill("Start a task with follow-ups");
  await input.press("Enter");
  await expect(stop).toBeVisible();
  await input.fill("Follow-up 1");
  await input.press("Enter");
  await expect(queuedRows).toHaveCount(1);
  await stop.click();
  await expect(chat.getByRole("button", { name: "Resume queue", exact: true })).toBeEnabled();

  for (let index = 2; index <= 18; index += 1) {
    await input.fill(`Follow-up ${index}`);
    await input.press("Enter");
  }
  await expect(queuedRows).toHaveCount(18);
  const desktopHeight = await queueList.evaluate((element) => element.clientHeight);
  expect(desktopHeight).toBeGreaterThan(240);

  await page.setViewportSize({ width: 1440, height: 440 });
  await input.fill("Draft line\n".repeat(10));
  await chat.locator('.composer input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(queue).toBeEnabled();

  const { clientHeight, scrollHeight } = await queueList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(clientHeight).toBeGreaterThan(0);
  expect(clientHeight).toBeLessThan(desktopHeight);
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  await queueList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => queueList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await expect(chat.getByRole("list", { name: "Attached images" })).toBeInViewport({ ratio: 0.99 });
  await expect(input).toBeInViewport({ ratio: 0.99 });
  await expect(queue).toBeInViewport({ ratio: 0.99 });
  const [pane, composer] = await Promise.all([
    chat.boundingBox(),
    chat.locator(".composer").boundingBox(),
  ]);
  if (!pane || !composer) throw new Error("Chat pane and composer must remain visible");
  expect(composer.y + composer.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
});
