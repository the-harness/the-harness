import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const indexHtml = readFileSync(new URL("../../apps/website/index.html", import.meta.url), "utf8");

describe("website bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("declares the mount point and module entry the app renders into", () => {
    expect(indexHtml).toContain('<div id="app"></div>');
    expect(indexHtml).toContain('<script type="module" src="/src/main.ts"></script>');
  });

  it("renders the product name into the #app container", async () => {
    const app = { textContent: "" };
    const querySelector = vi.fn((selector: string) => (selector === "#app" ? app : null));
    vi.stubGlobal("document", { querySelector });

    await import("../../apps/website/src/main.ts");

    expect(querySelector).toHaveBeenCalledWith("#app");
    expect(app.textContent).toBe("Harness");
  });
});
