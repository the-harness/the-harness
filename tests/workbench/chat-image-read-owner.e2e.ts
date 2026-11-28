import { expect, test } from "@playwright/test";

test("unmounting a chat message cancels only its pending image read", async ({ page }) => {
  const imageData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
  const reads = new Map<string, { id: string; reply: () => void }>();
  const cancelled: string[] = [];
  await page.routeWebSocket("**/api/transport/ws", (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as {
        type: string;
        id: string;
        path?: string;
        body?: { id: string };
      };
      if (frame.type === "request:cancel") cancelled.push(frame.id);
      if (frame.type !== "request" || frame.path !== "/rpc/images.read" || !frame.body) return;
      reads.set(frame.body.id, {
        id: frame.id,
        reply: () =>
          socket.send(
            JSON.stringify({
              type: "response",
              id: frame.id,
              ok: true,
              result: { mimeType: "image/png", data: imageData },
            }),
          ),
      });
    });
  });
  await page.route("**/chat-image-read-owner-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="app"></div><script type="module" src="/tests/chat-image-read-owner.fixture.ts"></script>',
    }),
  );
  await page.goto("/chat-image-read-owner-fixture");

  await expect.poll(() => [...reads.keys()].sort()).toEqual(["first", "second"]);
  await page.getByRole("button", { name: "Remove first message" }).click();
  await expect.poll(() => cancelled).toEqual([reads.get("first")!.id]);

  reads.get("second")!.reply();
  const image = page.locator("img");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  expect(cancelled).toEqual([reads.get("first")!.id]);
});
