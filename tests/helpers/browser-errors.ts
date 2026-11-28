import type { Page } from "@playwright/test";

export async function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    const rejections: string[] = [];
    Object.assign(window, { __harnessUnhandledRejections: rejections });
    window.addEventListener("unhandledrejection", (event) =>
      rejections.push(String(event.reason?.stack ?? event.reason)),
    );
  });
  return async () => {
    const rejections = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return (window as unknown as { __harnessUnhandledRejections: string[] })
        .__harnessUnhandledRejections;
    });
    return [...errors, ...rejections];
  };
}
