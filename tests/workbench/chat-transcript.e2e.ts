import { expect, test, type Page } from "@playwright/test";
import type { ChatMessagesPage } from "../../packages/ui-chat/src/types.ts";

const prompt = Array.from({ length: 12 }, (_, index) => `Prompt line ${index + 1}`).join("\n");
const response =
  "## Transcript review\n\nHere is **the result**.\n\n```ts\nconst ready = true;\n```";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";

function image(filename: string, fileId?: string) {
  return {
    $variants: ["core:llm:image"],
    mimeType: "image/png",
    ...(fileId ? { fileId } : { data: pixel }),
    filename,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  images: ReturnType<typeof image>[] = [],
) {
  return {
    $variants: [`core:llm:${role}`],
    id,
    ...(role === "assistant" ? { provider: "fixture", model: "fixture" } : {}),
    content: [{ $variants: ["core:llm:text"], text }, ...images],
  };
}

type HistoryPage = ChatMessagesPage;

async function mockHistory(
  page: Page,
  latest: HistoryPage,
  options: { older?: HistoryPage; imageGate?: Promise<void> } = {},
) {
  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "request" && frame.path === "/rpc/chat.loadMessages") {
          socket.send(
            JSON.stringify({
              type: "response",
              id: frame.id,
              ok: true,
              result: frame.body?.before !== undefined ? options.older : latest,
            }),
          );
        } else if (
          frame.type === "request" &&
          frame.path === "/rpc/images.read" &&
          options.imageGate
        ) {
          void options.imageGate.then(() =>
            socket.send(
              JSON.stringify({
                type: "response",
                id: frame.id,
                ok: true,
                result: { data: pixel, mimeType: "image/png" },
              }),
            ),
          );
        } else {
          server.send(raw);
        }
      });
    },
  );
}

async function openConversation(page: Page) {
  await page.goto("/");
  const chat = page.getByRole("region", { name: "Conversation", exact: true });
  await expect(chat).toBeVisible();
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  await expect(chat.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  return chat;
}

test("starts the first conversation from compact Chat and focuses the composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      const server = socket.connectToServer();
      let sessionStreamId: string | undefined;
      socket.onMessage((raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "stream:open" && frame.path === "/stream/state-sync:sessions.items") {
          sessionStreamId = frame.id;
        }
        server.send(raw);
      });
      server.onMessage((raw) => {
        const frame = JSON.parse(raw.toString());
        if (
          frame.type === "stream:data" &&
          frame.id === sessionStreamId &&
          frame.data.type === "snapshot"
        ) {
          frame.data.snapshot.items = [];
          socket.send(JSON.stringify(frame));
        } else {
          socket.send(raw);
        }
      });
    },
  );

  await page.goto("/");
  const chat = page.getByRole("region", { name: "Conversation", exact: true });
  await expect(chat.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Attach images" })).toHaveCount(0);
  await chat.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(chat.getByRole("heading", { name: "New conversation" })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message Harness" })).toBeFocused();
});

test("renders Markdown, collapses long prompts and copies a response in one action", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockHistory(page, {
    messages: [message("long-prompt", "user", prompt), message("response", "assistant", response)],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);

  await expect(chat.getByRole("heading", { name: "Transcript review" })).toBeVisible();
  await expect(chat.locator("pre code")).toContainText("const ready = true;");
  const toggle = chat.getByRole("button", { name: "Show more" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const textPreview = chat.locator(".prompt-preview");
  await expect
    .poll(() => textPreview.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await toggle.click();
  await expect(toggle).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Show less" })).toHaveCount(0);
  await expect(chat.locator(".u-text")).toBeFocused();
  await expect(textPreview).toHaveCount(0);

  await chat.getByRole("button", { name: "Copy response" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(response);
});

test("reveals prompt actions when hovering the empty row below the message", async ({ page }) => {
  await mockHistory(page, {
    messages: [
      message("hover-prompt", "user", "Reuse this prompt"),
      message("hover-response", "assistant", "Ready for the next prompt."),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const user = chat.locator(".chat-row.user");
  const actions = user.locator(".prompt-actions");
  const assistant = chat.locator(".chat-row.assistant");
  await chat.locator(".chat-heading").hover();
  await expect(actions).toHaveCSS("opacity", "0");
  const userBounds = (await user.boundingBox())!;
  const assistantBounds = (await assistant.boundingBox())!;
  const actionBounds = (await actions.boundingBox())!;
  await page.mouse.move(actionBounds.x + 2, actionBounds.y + actionBounds.height / 2);
  await expect(actions).toHaveCSS("opacity", "1");
  expect(await user.boundingBox()).toEqual(userBounds);
  expect(await assistant.boundingBox()).toEqual(assistantBounds);
  await user.getByRole("button", { name: "Reuse prompt", exact: true }).click();
  await expect(chat.getByRole("textbox", { name: "Message Harness" })).toHaveValue("Reuse this prompt");
});

test("keeps table header labels aligned in a narrow chat", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await mockHistory(page, {
    messages: [
      message("table-prompt", "user", "检查工具状态"),
      message(
        "table-response",
        "assistant",
        [
          "| 工具 | 状态 | 验证方式 |",
          "| --- | --- | --- |",
          "| `bash` | ✅ | `pwd` / `git branch` / `git log` / `env` |",
          "| `write` | ✅ | 创建 `temp/artifacts/tool-check.txt` |",
        ].join("\n"),
      ),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const headers = chat.getByRole("columnheader");
  await expect(headers).toHaveCount(3);
  await expect
    .poll(() =>
      headers.evaluateAll((cells) => cells.map((cell) =>
        cell.querySelector(".text-node")!.getBoundingClientRect().left -
        cell.getBoundingClientRect().left,
      )),
    )
    .toEqual([0, 0, 0]);
  await expect
    .poll(async () => {
      const tops = await headers.evaluateAll((cells) =>
        cells.map((cell) => cell.querySelector(".text-node")!.getBoundingClientRect().top),
      );
      return Math.max(...tops) - Math.min(...tops);
    })
    .toBeLessThan(1);
});

test("previews prompt images with keyboard focus and protects the draft when reusing a prompt", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 820 });
  const imageGate = Promise.withResolvers<void>();
  await mockHistory(
    page,
    {
      messages: [
        message("images", "user", "Compare these images", [
          image("delayed.png", "stored-image"),
          image("first.png"),
          image("second.png"),
        ]),
        message("text-only", "user", "Summarize the results"),
      ],
      nextBefore: null,
      hasMore: false,
    },
    { imageGate: imageGate.promise },
  );
  const chat = await openConversation(page);
  const firstImage = chat.getByRole("button", { name: "Preview first.png" });
  await firstImage.focus();
  await firstImage.press("Enter");
  const lightbox = page.getByRole("dialog", { name: "Image preview" });
  await expect(lightbox.getByRole("button", { name: "Close image preview" })).toBeFocused();
  imageGate.resolve();
  await expect(chat.locator('button[aria-label="Preview delayed.png"]')).toHaveCount(1);
  await expect(lightbox.getByRole("img", { name: "first.png" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(lightbox.getByRole("img", { name: "second.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(firstImage).toBeFocused();

  const composer = chat.getByRole("textbox", { name: "Message Harness" });
  const reuseImagePrompt = chat
    .locator("article")
    .filter({ hasText: "Compare these images" })
    .getByRole("button", { name: "Reuse prompt" });
  const reuseTextPrompt = chat
    .locator("article")
    .filter({ hasText: "Summarize the results" })
    .getByRole("button", { name: "Reuse prompt" });
  await reuseImagePrompt.click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Compare these images");
  const attachments = chat.getByRole("list", { name: "Attached images" });
  const inlineImage = attachments.getByRole("img", { name: "first.png" });
  await expect
    .poll(() => inlineImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  page.once("dialog", (dialog) => void dialog.dismiss());
  await reuseTextPrompt.click();
  await expect(composer).toHaveValue("Compare these images");
  page.once("dialog", (dialog) => void dialog.accept());
  await reuseTextPrompt.click();
  await expect(composer).toHaveValue("Summarize the results");
  await expect(chat.getByRole("list", { name: "Attached images" })).toHaveCount(0);
});

test("loads earlier history from the server and jumps back to the latest message", async ({
  page,
}) => {
  const recent = Array.from({ length: 30 }, (_, index) =>
    message(`recent-${index}`, "user", `Recent message ${index + 1}`),
  );
  await mockHistory(
    page,
    { messages: recent, nextBefore: 2, hasMore: true },
    {
      older: {
        messages: [message("old", "user", "First message in history")],
        nextBefore: null,
        hasMore: false,
      },
    },
  );
  const chat = await openConversation(page);
  const earlier = chat.getByRole("button", { name: "Load earlier messages", exact: true });
  await expect(earlier).toHaveCount(1);
  await earlier.click();
  await expect(chat.getByText("First message in history", { exact: true })).toHaveCount(1);
  await expect(earlier).toHaveCount(0);
  await expect(chat.getByRole("region", { name: "Messages" })).toBeFocused();
  await chat.getByRole("button", { name: "Jump to latest" }).click();
  await expect(chat.getByText("Recent message 30", { exact: true })).toBeInViewport();
  await expect(chat.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});

test("adds trailing space only when the history itself overflows", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await mockHistory(page, {
    messages: [
      message("fitting-prompt", "user", "Show the transcript"),
      message(
        "fitting-response",
        "assistant",
        Array.from({ length: 15 }, (_, index) => `Transcript line ${index + 1}.`).join("\n\n"),
      ),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const transcript = chat.getByRole("region", { name: "Messages", exact: true });
  await expect(chat.getByText("Transcript line 15.", { exact: true })).toBeVisible();
  const fittingHeight = await transcript.evaluate((el) =>
    Math.ceil(
      window.innerHeight - el.clientHeight + el.scrollTop +
      el.querySelector(".chat-row:last-child")!.getBoundingClientRect().bottom -
      el.getBoundingClientRect().top,
    ),
  );

  async function expectNoOverflow() {
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBe(0);
    await expect(chat.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  }

  await page.setViewportSize({ width: 900, height: fittingHeight + 20 });
  await expectNoOverflow();
  await page.setViewportSize({ width: 900, height: fittingHeight - 80 });
  await expect
    .poll(() =>
      transcript.evaluate((el) =>
        el.scrollHeight - el.scrollTop -
        el.querySelector(".chat-row:last-child")!.getBoundingClientRect().bottom +
        el.getBoundingClientRect().top,
      ),
    )
    .toBeGreaterThan(30);
  await page.setViewportSize({ width: 900, height: fittingHeight + 20 });
  await expectNoOverflow();
});

test("ignores trailing space for jump visibility and includes it in the destination", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await mockHistory(page, {
    messages: Array.from({ length: 30 }, (_, index) =>
      message(`history-${index}`, "user", `Message ${index + 1}\nSecond line\nThird line`),
    ),
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const transcript = chat.getByRole("region", { name: "Messages", exact: true });
  const jump = chat.getByRole("button", { name: "Jump to latest", exact: true });
  await expect(chat.locator(".chat-row")).toHaveCount(30);

  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(jump).toBeVisible();
  await transcript.evaluate((el) => {
    const last = el.querySelector(".chat-row:last-child")!;
    el.scrollTop += last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  });
  await expect(jump).toHaveCount(0);

  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(transcript).toBeFocused();
  await expect(jump).toHaveCount(0);
  await expect
    .poll(() =>
      transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await transcript.evaluate((el) =>
      Math.round(
        el.getBoundingClientRect().bottom -
        el.querySelector(".chat-row:last-child")!.getBoundingClientRect().bottom,
      ),
    ),
  ).toBe(48);
});

test("does not reserve hidden footer space between completed turns", async ({ page }) => {
  await mockHistory(page, {
    messages: [
      message("first-prompt", "user", "Check the tools"),
      message("first-answer", "assistant", "The tools work correctly."),
      message("second-prompt", "user", "11"),
      message("second-answer", "assistant", "What should I check next?"),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const previous = chat.locator(".chat-row.assistant").first();
  const footer = previous.locator(".a-msg-ft");
  const nextPrompt = chat.locator(".chat-row.user").last();
  await expect(previous.locator(".a-prose")).toHaveText("The tools work correctly.");

  async function turnGap() {
    const prose = (await previous.locator(".a-prose").boundingBox())!;
    return (await nextPrompt.boundingBox())!.y - prose.y - prose.height;
  }

  await chat.locator(".chat-heading").hover();
  await expect(footer).toHaveCSS("opacity", "0");
  expect(await turnGap()).toBe(18);
  await previous.hover();
  await expect(footer).toHaveCSS("opacity", "1");
  expect(await turnGap()).toBe(18);
  const footerBounds = (await footer.boundingBox())!;
  expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual((await nextPrompt.boundingBox())!.y);

  const last = chat.locator(".chat-row.assistant").last();
  const positions = [];
  for (const row of [previous, last]) {
    const prose = (await row.locator(".a-prose").boundingBox())!;
    const button = (await row.getByRole("button", { name: "Copy response", exact: true }).boundingBox())!;
    positions.push({
      left: button.x - prose.x,
      top: button.y - prose.y - prose.height,
      width: button.width,
      height: button.height,
    });
  }
  expect(positions[1]).toEqual(positions[0]);
  expect(positions[1]).toEqual({ left: 0, top: 2, width: 16, height: 16 });
  await chat.locator(".chat-heading").hover();
  await expect(footer).toHaveCSS("opacity", "0");
  await expect(last.locator(".a-msg-ft")).toHaveCSS("opacity", "0.65");
});

function toolHistory(prefix: string, withThought = true, text = ""): HistoryPage["messages"] {
  return [
    message(`${prefix}-prompt`, "user", `Inspect ${prefix} files`),
    {
      id: `${prefix}-tools`,
      $variants: ["core:llm:assistant"],
      provider: "fixture",
      model: "fixture",
      content: [
        ...(withThought
          ? [{ $variants: ["core:llm:thinking"], thinking: `Planning ${prefix} tool calls` }]
          : []),
        { $variants: ["core:llm:thinking"], thinking: "Redacted provider content", redacted: true },
        {
          $variants: ["core:llm:tool-call"],
          id: `${prefix}-read`,
          name: "read",
          arguments: JSON.stringify({ path: `src/${prefix}.ts` }),
        },
        {
          $variants: ["core:llm:tool-call"],
          id: `${prefix}-bash`,
          name: "bash",
          arguments: JSON.stringify({ command: `cat ${prefix}-missing.txt` }),
        },
        ...(text ? [{ $variants: ["core:llm:text"], text }] : []),
      ],
    },
    {
      id: `${prefix}-bash-result`,
      $variants: ["core:llm:tool"],
      toolCallId: `${prefix}-bash`,
      toolName: "bash",
      isError: true,
      content: [{ $variants: ["core:llm:text"], text: `${prefix}-missing.txt: No such file` }],
    },
    {
      id: `${prefix}-read-result`,
      $variants: ["core:llm:tool"],
      toolCallId: `${prefix}-read`,
      toolName: "read",
      content: [{ $variants: ["core:llm:text"], text: `export const ${prefix} = true;` }],
    },
    message(`${prefix}-summary`, "assistant", `Finished inspecting ${prefix} files`),
  ];
}

async function expectToolHistory(page: Page, prefix: string) {
  const chat = page.getByRole("region", { name: "Conversation", exact: true });
  const group = chat.locator(".activity-run > .ar-head");
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
  await expect(chat.locator(".tool-line")).toHaveCount(2);
  const thought = chat.locator(".think-head");
  await expect(thought).toHaveCount(1);
  if ((await thought.getAttribute("aria-expanded")) !== "true") await thought.click();
  await expect(chat.getByText(`Planning ${prefix} tool calls`, { exact: true })).toBeVisible();
  await expect(chat.getByText("Redacted provider content", { exact: true })).toHaveCount(0);

  const read = chat.locator(".tool-line").filter({ hasText: `${prefix}.ts` });
  const bash = chat.locator(".tool-line").filter({ hasText: `cat ${prefix}-missing.txt` });
  for (const tool of [read, bash]) {
    const header = tool.locator(".tl-head");
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  }
  await expect(read.locator("pre")).toHaveText(`export const ${prefix} = true;`);
  await expect(read.locator('[aria-label="Error"]')).toHaveCount(0);
  await expect(bash.locator(".tool-output")).toHaveText(`${prefix}-missing.txt: No such file`);
  await expect(bash.locator('[aria-label="Error"]')).toBeVisible();
  await expect(chat.locator(".tl-dot.running")).toHaveCount(0);
  await expect(chat.getByText(`Finished inspecting ${prefix} files`, { exact: true })).toBeVisible();
}

test("single and grouped thought summaries retain saved elapsed time after reload", async ({ page }) => {
  const thought = (text: string) => ({ $variants: ["core:llm:thinking"], thinking: text });
  const text = (value: string) => ({ $variants: ["core:llm:text"], text: value });
  const timed = (id: string, durationMs: number, content: unknown[]) => ({
    $variants: ["core:llm:assistant"],
    id,
    provider: "fixture",
    model: "fixture",
    meta: { "core:ui-chat:duration-ms": durationMs },
    content,
  });
  await mockHistory(page, {
    messages: [
      message("single-prompt", "user", "A single thought"),
      timed("single-thought", 3000, [thought("Single thought details."), text("Single answer")]),
      message("thoughts-prompt", "user", "Two thoughts"),
      timed("first-thought", 1500, [thought("First thought details.")]),
      timed("second-thought", 2500, [thought("Second thought details."), text("Two-thought answer")]),
      message("tools-prompt", "user", "Thinking and tools"),
      timed("tools-thought", 2000, [
        thought("Plan the file read."),
        {
          $variants: ["core:llm:tool-call"],
          id: "timed-read",
          name: "read",
          arguments: JSON.stringify({ path: "package.json" }),
        },
      ]),
      timed("tools-answer", 4000, [thought("Review the file."), text("Tool answer")]),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  for (let load = 0; load < 2; load++) {
    const single = chat.getByRole("button", { name: "Thought for 3s", exact: true });
    await expect(single).toHaveAttribute("aria-expanded", "false");
    await expect(single.locator(".think-ic")).toBeHidden();
    await expect(single.locator(".think-preview")).toBeHidden();
    await expect(chat.getByRole("button", { name: "Thought for 4s", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    const tools = chat.getByRole("button", { name: "Thought and called 1 tool in 6s", exact: true });
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    await single.click();
    await expect(single.locator(".think-ic")).toBeVisible();
    await expect(chat.getByText("Single thought details.", { exact: true })).toBeVisible();
    await tools.click();
    await expect(chat.getByRole("button", { name: "Thought Plan the file read.", exact: true })
      .locator(".think-ic")).toBeVisible();
    if (load === 0) await page.reload();
  }
});

test("restores thinking and tool results after reloading and switching conversations", async ({ page }) => {
  const history = { messages: toolHistory("latest"), nextBefore: null, hasMore: false };
  await mockHistory(page, history);
  await openConversation(page);
  await expectToolHistory(page, "latest");
  const sessionId = await page.evaluate(async () =>
    (await import("/tests/composer-draft.fixture.ts")).currentSessionId(),
  );

  await page.reload();
  await expectToolHistory(page, "latest");
  history.messages = [message("other-prompt", "user", "Another conversation without tools")];
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  await expect(page.getByText("Another conversation without tools", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-line")).toHaveCount(0);
  history.messages = toolHistory("latest");
  await page.evaluate(
    async (id) => (await import("/tests/composer-draft.fixture.ts")).selectSession(id),
    sessionId,
  );
  await expectToolHistory(page, "latest");
  await expect(page.locator(".chat-row")).toHaveCount(2);
});

test("restores tool calls and matched results when loading earlier history", async ({ page }) => {
  await mockHistory(
    page,
    {
      messages: [
        message("recent-prompt", "user", "Recent prompt"),
        message("recent-answer", "assistant", "Recent answer"),
      ],
      nextBefore: 2,
      hasMore: true,
    },
    {
      older: { messages: toolHistory("older"), nextBefore: null, hasMore: false },
    },
  );
  const chat = await openConversation(page);
  await chat.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expectToolHistory(page, "older");
  await expect(chat.locator(".chat-row")).toHaveCount(4);
  await expect(chat.getByText("Recent answer", { exact: true })).toBeVisible();
});

test("keeps consecutive thoughts and tools compact across assistant steps", async ({ page }) => {
  await mockHistory(page, {
    messages: [
      ...toolHistory("first").slice(0, -1),
      ...toolHistory("next").slice(1, -1),
      ...toolHistory("last", false).slice(1),
      message("next-prompt", "user", "Continue reviewing"),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const group = chat.locator(".activity-run > .ar-head");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await group.click();
  const activities = chat.locator(".ar-body-inner > .think-block, .ar-body-inner > .tool-line");
  await expect(activities).toHaveCount(8);

  async function expectCompactActivities() {
    const gaps = await activities.evaluateAll((elements) =>
      elements.slice(1).map((element, index) =>
        element.getBoundingClientRect().top - elements[index]!.getBoundingClientRect().bottom,
      ),
    );
    for (const gap of gaps) {
      expect(gap).toBe(0);
    }
  }

  await expectCompactActivities();
  const read = chat.getByRole("button", { name: "Read first.ts", exact: true });
  await read.click();
  await expect(chat.locator(".tool-line").filter({ hasText: "first.ts" }).locator("pre")).toBeVisible();
  await expectCompactActivities();
  await read.click();
  await expect(read).toHaveAttribute("aria-expanded", "false");
  await expectCompactActivities();

  const lastActivity = await activities.last().boundingBox();
  const summary = await chat.locator(".a-prose").boundingBox();
  const nextPrompt = await chat.locator(".u-turn").last().boundingBox();
  expect(summary!.y - lastActivity!.y - lastActivity!.height).toBe(12);
  expect(nextPrompt!.y - summary!.y - summary!.height).toBeGreaterThanOrEqual(18);

  await page.reload();
  await group.click();
  await expect(activities).toHaveCount(8);
  await expectCompactActivities();
});

test("does not reserve a footer row between commentary and the next tool step", async ({ page }) => {
  await mockHistory(page, {
    messages: [
      ...toolHistory("commentary", true, "我来逐个测试工具。").slice(0, -1),
      ...toolHistory("next").slice(1),
    ],
    nextBefore: null,
    hasMore: false,
  });
  const chat = await openConversation(page);
  const groups = chat.locator(".activity-run > .ar-head");
  await expect(groups).toHaveCount(2);
  for (const group of await groups.all()) await group.click();
  const row = chat.locator(".chat-row.assistant").first();
  const prose = row.locator(".a-prose");
  const footer = row.locator(".a-msg-ft");
  const nextGroup = chat.locator(".activity-run").nth(1);
  await expect(prose).toHaveText("我来逐个测试工具。");
  await expect(footer).toBeHidden();
  const toolBounds = (await row.locator(".tool-line").last().boundingBox())!;
  const proseBounds = (await prose.boundingBox())!;
  const rowBounds = (await row.boundingBox())!;
  const nextGroupBounds = (await nextGroup.boundingBox())!;
  expect(proseBounds.y - toolBounds.y - toolBounds.height).toBe(12);
  expect(rowBounds.y + rowBounds.height).toBe(proseBounds.y + proseBounds.height);
  expect(nextGroupBounds.y - proseBounds.y - proseBounds.height).toBeGreaterThanOrEqual(0);
  expect(nextGroupBounds.y - proseBounds.y - proseBounds.height).toBeLessThanOrEqual(4);

  await row.hover();
  await expect(footer).toBeHidden();
  expect((await row.boundingBox())!.height).toBe(rowBounds.height);
  expect((await nextGroup.boundingBox())!.y).toBe(nextGroupBounds.y);
  await expect(row.getByRole("button", { name: "Copy response" })).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Copy response" })).toHaveCount(1);
});
