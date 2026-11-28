import { expect, test } from "@playwright/test";

for (const source of ["queue", "composer"] as const) {
  test(`the ${source} lightbox displays saved images as their reads complete`, async ({ page }) => {
    const replies = new Map<string, () => void>();
    await page.routeWebSocket(
      (url) => url.pathname === "/api/transport/ws",
      (socket) => {
        const server = socket.connectToServer();
        const requests = new Map<string, string>();
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (frame.type === "request" && frame.path === "/rpc/images.read") {
            requests.set(frame.id, frame.body.id);
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const { id, type } = JSON.parse(message.toString());
          const imageId = requests.get(id);
          if (type === "response" && imageId) {
            requests.delete(id);
            replies.set(imageId, () => socket.send(message));
            return;
          }
          socket.send(message);
        });
      },
    );

    await page.goto("/tests/chat-image-lightbox.fixture.html");
    const [first, second] = await page.evaluate(async () =>
      (await import("/tests/chat-image-lightbox.fixture.ts")).openChatWithSavedImages(),
    );
    await expect.poll(() => [...replies.keys()].sort()).toEqual([first, second].sort());
    if (source === "composer") {
      await page.locator(".pending-item").hover();
      await page.getByRole("button", { name: "Edit queued message 1", exact: true }).click();
    }
    const thumbnails = page.locator(
      source === "queue" ? ".pending-image-thumb" : ".composer-image-preview",
    );
    await thumbnails.first().click();
    const lightbox = page.getByRole("dialog", { name: "Image preview" });
    const image = lightbox.locator("img");
    const width = () => image.evaluate((element: HTMLImageElement) => element.naturalWidth);
    await expect(image).toHaveAttribute("alt", "1px.png");
    expect(await width()).toBe(0);

    await lightbox.getByRole("button", { name: "Next image" }).click();
    await expect(image).toHaveAttribute("alt", "2px.png");
    replies.get(first)!();
    await expect
      .poll(() =>
        thumbnails
          .first()
          .locator("img")
          .evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1);
    expect(await width()).toBe(0);

    replies.get(second)!();
    await expect.poll(width).toBe(2);
    await lightbox.getByRole("button", { name: "Previous image" }).click();
    await expect(image).toHaveAttribute("alt", "1px.png");
    await expect.poll(width).toBe(1);
  });
}
