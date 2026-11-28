import { expect, test } from "@playwright/test";

for (const target of ["initial path", "new folder"] as const) {
  test(`file picker keeps ${target} focus while its initial directory loads`, async ({ page }) => {
    const release = Promise.withResolvers<void>();
    let requested = false;
    await page.routeWebSocket("**/api/transport/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "request" && frame.path === "/rpc/file-picker.list" && !requested) {
          requested = true;
          void release.promise.then(() => server.send(raw));
        } else server.send(raw);
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Open folder as workspace", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open Folder as Workspace", exact: true });
    const path = dialog.getByRole("combobox", { name: "Path", exact: true });
    try {
      await expect.poll(() => requested).toBe(true);
      await expect(dialog.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
      if (target === "initial path") {
        await expect(path).toBeFocused();
      } else {
        await dialog.getByRole("button", { name: "New Folder", exact: true }).click();
        const name = dialog.getByRole("textbox", { name: "New folder name", exact: true });
        await name.fill("Keep editing");
        await expect(name).toBeFocused();
      }
      release.resolve();
      await expect(dialog.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
      if (target === "initial path") await expect(path).toBeFocused();
      else {
        const name = dialog.getByRole("textbox", { name: "New folder name", exact: true });
        await expect(name).toBeFocused();
        await page.keyboard.type(" here");
        await expect(name).toHaveValue("Keep editing here");
      }
    } finally {
      release.resolve();
    }
  });
}
