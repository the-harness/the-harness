import { expect, test, type Locator } from "@playwright/test";

const draft = Array.from({ length: 9 }, (_, i) => `Draft line ${i + 1}`).join("\n");
const bottomGap = (transcript: Locator) => transcript.evaluate(
  (el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight),
);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 720 });
  await page.route("**/chat-layout-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><div id="app"></div>',
  }));
  await page.goto("/chat-layout-fixture");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).mountChat(),
  );
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).populateChat(),
  );
  await expect(page.locator(".chat-row")).toHaveCount(3);
});

test("initial overflow and composer resizing keep the entire bottom spacer in view", async ({ page }) => {
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await expect.poll(() => bottomGap(transcript)).toBeLessThan(1);
  const height = await transcript.evaluate((el) => el.clientHeight);
  const composer = page.getByRole("textbox", { name: "Message Harness" });
  await composer.fill(draft);
  await expect.poll(() => transcript.evaluate((el) => el.clientHeight)).toBeLessThan(height);
  await expect.poll(() => bottomGap(transcript)).toBeLessThan(1);
  await composer.fill("");
  await expect.poll(() => bottomGap(transcript)).toBeLessThan(1);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});

test("resizing and streaming leave a reader in place until Jump to latest", async ({ page }) => {
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await transcript.press("Home");
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  const top = await transcript.evaluate((el) => el.scrollTop);
  await page.getByRole("textbox", { name: "Message Harness" }).fill(draft);
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(top);
  await jump.click();
  await expect.poll(() => bottomGap(transcript)).toBeLessThan(1);
  await expect(jump).toHaveCount(0);
});

test("a short conversation stays unscrollable after the composer changes height", async ({ page }) => {
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).populateChat(true),
  );
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await page.getByRole("textbox", { name: "Message Harness" }).fill(draft);
  await expect(transcript).not.toHaveClass(/has-overflow/);
  await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
});

test("expanding a thought does not mistake the new scrollbar for a viewport resize", async ({ page }) => {
  await page.evaluate(async () => {
    const fixture = await import("/tests/chat-detail-polish.fixture.ts");
    fixture.populateChat(true);
    fixture.growActivity();
    fixture.growActivity();
  });
  const thought = page.locator(".think-head");
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await expect(transcript).not.toHaveClass(/has-overflow/);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await thought.click();
  await expect(transcript).toHaveClass(/has-overflow/);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0);
});

test("streamed thinking stays one line and does not create overflow or jump on completion", async ({ page }) => {
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).populateChat(true),
  );
  const thought = page.locator(".think-block");
  const height = await thought.evaluate((el) => el.getBoundingClientRect().height);
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  for (let chunk = 0; chunk < 3; chunk++) {
    await page.evaluate(async () =>
      (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
    );
    await expect.poll(() => thought.evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
    await expect(transcript).not.toHaveClass(/has-overflow/);
  }
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishChatActivity(),
  );
  await expect(page.locator(".think-title")).toHaveText("Thought for 3s");
  await expect.poll(() => thought.evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});

test("a single thought keeps its title aligned when expanded and collapsed", async ({ page }) => {
  await page.evaluate(async () => {
    const fixture = await import("/tests/chat-detail-polish.fixture.ts");
    fixture.populateChat(true);
    fixture.finishChatActivity();
  });
  const thought = page.getByRole("button", { name: "Thought for 3s", exact: true });
  const title = thought.locator(".think-title");
  const left = await title.evaluate((el) => el.getBoundingClientRect().left);
  await expect(thought.locator(".think-ic")).toBeHidden();
  for (const expanded of ["true", "false"]) {
    await thought.click();
    await expect(thought).toHaveAttribute("aria-expanded", expanded);
    await expect(thought.locator(".think-ic")).toBeHidden();
    await expect.poll(() => title.evaluate((el) => el.getBoundingClientRect().left)).toBe(left);
  }
});

test("thinking preview waits for a complete sentence or paragraph first line and truncates", async ({ page }) => {
  const update = (text: string) => page.evaluate(async (value) =>
    (await import("/tests/chat-detail-polish.fixture.ts")).setThoughtText(value), text,
  );
  const preview = page.locator(".think-preview");
  await update("Checking the layout");
  await expect(preview).toHaveCount(0);
  await update("Checking the layout.\n\nReviewing");
  await expect(preview).toHaveText("Checking the layout.");
  await update("Checking the layout.\n\nReviewing the streamed response");
  await expect(preview).toHaveText("Checking the layout.");
  await update("Checking the layout.\n\nReviewing the streamed response\nDetails are arriving");
  await expect(preview).toHaveText("Reviewing the streamed response");
  await update("现在检查布局。接着检查滚动");
  await expect(preview).toHaveText("现在检查布局。");
  await update("Checking " + "a very long stream of reasoning ".repeat(30) + ".");
  await expect.poll(() => preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect.poll(() => page.locator(".think-block").evaluate((el) => el.getBoundingClientRect().height)).toBe(22);
  await expect.poll(() => page.locator(".chat-panel").evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});

test("opening a streamed thought anchors its heading and keeps the reader in place", async ({ page }) => {
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  const thought = page.locator(".think-head");
  const top = await thought.evaluate((el) => el.getBoundingClientRect().top);
  await thought.click();
  await expect.poll(() => thought.evaluate((el) => el.getBoundingClientRect().top)).toBe(top);
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  const scrollTop = await transcript.evaluate((el) => el.scrollTop);
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishChatActivity(),
  );
  await expect(thought).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(scrollTop);
});

for (const target of ["thought", "tool", "group"] as const) {
  test(`keyboard disclosure preserves the ${target} heading and pauses following`, async ({ page }) => {
    await page.evaluate(async (kind) => {
      const fixture = await import("/tests/chat-detail-polish.fixture.ts");
      fixture.growActivity();
      if (kind !== "thought") fixture.appendToolAndThought();
      if (kind === "group") fixture.finishChatActivity();
    }, target);
    const header = page.locator(target === "thought" ? ".think-head" : target === "tool" ? ".tl-head" : ".ar-head");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    if (target === "group") {
      await expect.poll(() => page.locator(".ar-body").evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
    }
    await header.focus();
    const top = await header.evaluate((el) => el.getBoundingClientRect().top);
    await header.press("Space");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => header.evaluate((el) => el.getBoundingClientRect().top)).toBe(top);
    const transcript = page.getByRole("region", { name: "Messages", exact: true });
    const scrollTop = await transcript.evaluate((el) => el.scrollTop);
    await page.evaluate(async () =>
      (await import("/tests/chat-detail-polish.fixture.ts")).appendAssistantText(),
    );
    await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(scrollTop);
    await expect(header).toBeFocused();
  });
}

test("thinking to tool to thinking keeps explicit expansion and starts the next thought collapsed", async ({ page }) => {
  const thought = page.locator(".think-head").first();
  await thought.click();
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).appendToolAndThought(),
  );
  await expect(page.locator(".think-head")).toHaveCount(2);
  await expect(thought).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".think-head").last()).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).finishChatActivity(),
  );
  await expect(page.locator(".ar-head")).toHaveAttribute("aria-expanded", "true");
  await expect(thought).toHaveAttribute("aria-expanded", "true");
});

test("a small upward scroll stops following even inside the old bottom threshold", async ({ page }) => {
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await transcript.hover();
  const bottom = await transcript.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -32);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeCloseTo(bottom - 32, 0);
  const top = await transcript.evaluate((el) => el.scrollTop);
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(top);
});

test("selecting thinking text pauses following while more reasoning arrives", async ({ page }) => {
  await page.evaluate(async () => {
    const fixture = await import("/tests/chat-detail-polish.fixture.ts");
    fixture.populateChat(true);
    fixture.growActivity();
    fixture.growActivity();
  });
  await page.locator(".think-head").click();
  const transcript = page.getByRole("region", { name: "Messages", exact: true });
  await transcript.press("End");
  await expect.poll(() => bottomGap(transcript)).toBeLessThan(1);
  await page.locator(".think-text").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  const top = await transcript.evaluate((el) => el.scrollTop);
  await page.evaluate(async () =>
    (await import("/tests/chat-detail-polish.fixture.ts")).growActivity(),
  );
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(top);
});
