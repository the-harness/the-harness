import { expect, test, type APIRequestContext } from "@playwright/test";

async function createShell(request: APIRequestContext, label: string) {
  const title = `${label} ${crypto.randomUUID()}`;
  const response = await request.post("/api/terminals", {
    data: { title, shell: "/bin/sh", args: ["-s"] },
  });
  expect(response.ok()).toBe(true);
  const { id } = (await response.json()) as { id: string };
  return { id, title, url: `/api/terminals/${encodeURIComponent(id)}` };
}

test("switching terminals focuses the PTY or the active terminal's open Find", async ({
  page,
  request,
}) => {
  const first = await createShell(request, "Focus terminal");
  const second = await createShell(request, "Other terminal");
  const ready = new Set<string>();
  let firstInput = "";
  let firstOutput = "";
  let secondInput = "";
  page.on("websocket", (socket) => {
    const path = new URL(socket.url()).pathname;
    const shell = [first, second].find(({ id }) => path === `/ws/terminals/${encodeURIComponent(id)}`);
    if (!shell) return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as { type: string; data?: string };
      if (frame.type !== "input") return;
      if (shell === first) firstInput += frame.data;
      else secondInput += frame.data;
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as { type: string; data?: string };
      if (frame.type === "snapshot") ready.add(shell.id);
      if (frame.type === "data" && shell === first) firstOutput += frame.data;
    });
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
    const firstTab = page.getByRole("button", { name: first.title });
    const secondTab = page.getByRole("button", { name: second.title });
    const input = page.getByRole("textbox", { name: "Terminal input", exact: true });
    await expect.poll(() => ready.size).toBe(2);
    await secondTab.click();
    await firstTab.click();
    await expect(input).toBeFocused();
    await page.keyboard.type("printf '\\nHARNESS_FOCUS_OK\\n'");
    await page.keyboard.press("Enter");
    await expect.poll(() => firstOutput).toMatch(/\r?\nHARNESS_FOCUS_OK\r?\n/);
    expect(firstInput).toContain("HARNESS_FOCUS_OK");
    expect(secondInput).toBe("");

    await page.getByTitle("Find (Cmd/Ctrl+F)", { exact: true }).click();
    const find = page.getByPlaceholder("Find", { exact: true });
    await expect(find).toBeFocused();
    await find.fill("original query");
    await secondTab.click();
    await expect(input).toBeFocused();
    await firstTab.click();
    await expect(find).toHaveValue("original query");
    await expect(find).toBeFocused();
    const previousInput = firstInput;
    await page.keyboard.type(" continued");
    await page.keyboard.press("Enter");
    await expect.poll(() => find.inputValue()).toContain("continued");
    expect(firstInput).toBe(previousInput);
    expect(secondInput).toBe("");
  } finally {
    await Promise.all([request.delete(first.url), request.delete(second.url)]);
  }
});

test("loading a terminal inventory leaves focus where the user moved it", async ({
  page,
  request,
}) => {
  const first = await createShell(request, "Loading terminal");
  const second = await createShell(request, "Inactive terminal");
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/terminals", async (route) => {
    if (route.request().method() === "GET") {
      requested.resolve();
      await release.promise;
    }
    await route.continue();
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Open command palette", exact: true }).press("ControlOrMeta+n");
    const composer = page.getByRole("textbox", { name: "Message Harness", exact: true });
    await expect(composer).toBeVisible();
    await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
    await requested.promise;
    await composer.fill("Keep the draft");
    await expect(composer).toBeFocused();

    release.resolve();
    await expect(page.getByRole("button", { name: first.title })).toBeVisible();
    await expect(page.getByRole("button", { name: second.title })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await page.keyboard.type(" intact");
    await expect(composer).toHaveValue("Keep the draft intact");
  } finally {
    release.resolve();
    await Promise.all([request.delete(first.url), request.delete(second.url)]);
  }
});
