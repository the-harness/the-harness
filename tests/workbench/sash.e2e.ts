import { expect, test } from "@playwright/test";

test("sash highlights after 300ms hover, immediately on drag, locks drag cursor, and ignores disabled state", async ({
  page,
}) => {
  await page.goto("/");
  const sash = page.locator(".dv-sash").first();
  await expect(sash).toBeVisible();
  const box = (await sash.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await expect(sash).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.waitForTimeout(450);
  await expect(sash).toHaveCSS("background-color", "rgb(57, 148, 188)");

  await page.mouse.move(100, 150);
  await expect(sash).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await page.mouse.down();
  await expect(sash).toHaveClass(/dv-sash-active/);
  await expect(sash).toHaveCSS("background-color", "rgb(57, 148, 188)");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).cursor))
    .toMatch(/^(col-resize|ew-resize)$/);

  await page.mouse.move(80, box.y + 150, { steps: 6 });
  await expect(sash).toHaveClass(/dv-minimum/);
  await expect(sash).toHaveClass(/dv-sash-active/);
  await expect(sash).toHaveCSS("background-color", "rgb(57, 148, 188)");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).cursor))
    .toBe("e-resize");

  await page.mouse.up();
  await expect(sash).not.toHaveClass(/dv-sash-active/);
  await expect(sash).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).cursor)).toBe("auto");

  await sash.evaluate((el) => {
    el.classList.remove("dv-enabled", "dv-minimum", "dv-maximum");
    el.classList.add("dv-disabled");
  });
  const disabledBox = (await sash.boundingBox())!;
  await page.mouse.move(disabledBox.x + disabledBox.width / 2, disabledBox.y + 150);
  await page.waitForTimeout(400);
  await expect(sash).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(sash).toHaveCSS("pointer-events", "none");
});
