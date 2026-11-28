import { expect, test, type Page } from "@playwright/test";

const reviewIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="coral"/></svg>',
)}`;
const presets = [
  { id: "first", name: "Code assistant", description: "Work on the current project." },
  {
    id: "second",
    name: "Review assistant",
    description: "Review changes before committing.",
    icon: { src: reviewIcon },
  },
];

async function openChat(page: Page, choices = presets, response?: string) {
  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "request" && frame.path === "/rpc/chat.listPresets") {
          socket.send(
            JSON.stringify({ type: "response", id: frame.id, ok: true, result: choices }),
          );
        } else if (
          frame.type === "request" &&
          frame.path === "/rpc/chat.loadMessages" &&
          response
        ) {
          socket.send(
            JSON.stringify({
              type: "response",
              id: frame.id,
              ok: true,
              result: {
                messages: [
                  {
                    $variants: ["core:llm:assistant"],
                    id: "response",
                    provider: "fixture",
                    model: "fixture",
                    content: [{ $variants: ["core:llm:text"], text: response }],
                  },
                ],
                nextBefore: null,
                hasMore: false,
              },
            }),
          );
        } else {
          server.send(raw);
        }
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .press("ControlOrMeta+n");
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
  return page.getByRole("button", { name: "Select agent preset", exact: true });
}

test("preset menu dismisses with Escape and returns focus to its trigger", async ({ page }) => {
  const trigger = await openChat(page);
  await expect(trigger).toContainText("Code assistant");
  await trigger.click();
  const menu = page.locator('[aria-label="Agent presets"]');
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("preset menu supports keyboard selection and exposes the selected preset", async ({
  page,
}) => {
  const trigger = await openChat(page);
  await expect(trigger).toContainText("Code assistant");
  await trigger.press("ArrowDown");
  const first = page.getByRole("menuitemradio", { name: "Code assistant", exact: true });
  const second = page.getByRole("menuitemradio", { name: "Review assistant", exact: true });
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(first.locator(".i-codicon-sparkle")).toBeVisible();
  await expect(second.locator("img.agent-preset-icon")).toHaveAttribute("src", reviewIcon);
  await expect
    .poll(() =>
      second.locator("img.agent-preset-icon").evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("Review assistant");
  await expect(trigger.locator("img.agent-preset-icon")).toHaveAttribute("src", reviewIcon);
  await expect(trigger.locator(".i-codicon-sparkle")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(second).toHaveAttribute("aria-checked", "true");
  await page.getByRole("textbox", { name: "Message Harness" }).click();
  await expect(page.getByRole("menu", { name: "Agent presets" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeFocused();
});

test("preset menu fits a narrow viewport and wraps long names", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const longName = "Code assistant for a project with an unusually long workspace name";
  const trigger = await openChat(page, [{ ...presets[0]!, name: longName }, presets[1]!]);
  await expect(trigger).toContainText(longName);
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Agent presets" });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(312);
  const name = page
    .getByRole("menuitemradio", { name: longName, exact: true })
    .locator(".preset-name");
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("an empty preset menu explains the missing choices", async ({ page }) => {
  const trigger = await openChat(page, []);
  await expect(trigger).toHaveText("No preset");
  await trigger.click();
  const empty = page.getByRole("menuitem", { name: "No agent presets available", exact: true });
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("aria-disabled", "true");
});

test("copy actions confirm locally without adding notifications", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = "Result:\n\n```ts\nconst ready = true;\n```";
  await openChat(page, presets, response);
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Response copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(response);
  await expect(page.locator(".ui-notification-toast")).toHaveCount(0);
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Code copied", exact: true })).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(
    "const ready = true;",
  );
  await expect(page.locator(".ui-notification-toast")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeVisible();
});
