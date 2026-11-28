import { expect, test } from "@playwright/test";

test("a stored image can recover after its first preview read returns no image", async ({
  page,
}) => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
  const releaseFirstRead = Promise.withResolvers<void>();
  const reads: string[] = [];
  await page.routeWebSocket(
    (url) => url.pathname === "/api/transport/ws",
    (socket) => {
      socket.onMessage(async (raw) => {
        const { type, path, id, body } = JSON.parse(raw.toString());
        if (type !== "request" || path !== "/rpc/images.read") return;
        reads.push(body.id);
        const firstRead = reads.length === 1;
        if (firstRead) await releaseFirstRead.promise;
        const result = firstRead ? null : { mimeType: "image/png", data };
        socket.send(JSON.stringify({ type: "response", id, ok: true, result }));
      });
    },
  );

  try {
    await page.goto("/tests/image-preview-recovery.fixture.html");
    const images = page.locator(".msg-images img");
    const update = page.getByRole("button", { name: "Update message", exact: true });
    const widths = () =>
      images.evaluateAll((elements) =>
        elements.map((element) => (element as HTMLImageElement).naturalWidth),
      );
    await expect(images).toHaveCount(2);
    await expect.poll(() => reads).toEqual(["stored-image"]);
    expect(await widths()).toEqual([0, 0]);

    releaseFirstRead.resolve();
    await expect
      .poll(async () => {
        await update.click();
        return widths();
      })
      .toEqual([1, 1]);

    const message = page.locator(".u-text");
    const previousText = await message.innerText();
    const cached = await images.first().evaluate((element) => (element as HTMLImageElement).src);
    expect(cached).toMatch(/^blob:/);
    await update.click();
    await expect(message).not.toHaveText(previousText);
    await expect(images.first()).toHaveAttribute("src", cached);
    await expect(images.last()).toHaveAttribute("src", cached);
    expect(reads).toEqual(["stored-image", "stored-image"]);
  } finally {
    releaseFirstRead.resolve();
  }
});
