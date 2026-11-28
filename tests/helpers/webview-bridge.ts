import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export function createWebviewBridge(page: Page, root: string) {
  let calls: Promise<unknown> = Promise.resolve();
  let sequence = 0;
  return {
    async prepare() {
      await page.evaluate(() => import("/tests/vscode-webview.fixture.ts"));
    },
    async drain() {
      await calls;
    },
    async dispatch(_session: string, method: string, args: unknown[]) {
      if (!method.startsWith("webview.")) return { handled: false };
      // The production webview consumer runs synchronously in stream order.
      calls = calls.then(async () => {
        const observed = await page.evaluate(
          async ({ method, args }) => {
            const fixture = await import("/tests/vscode-webview.fixture.ts");
            return {
              result: fixture.dispatchWebview(method, args),
              panels: fixture.panels().map(({ id, enableScripts }) => ({ id, enableScripts })),
            };
          },
          { method, args },
        );
        appendFileSync(
          join(root, "webview-dispatch.jsonl"),
          JSON.stringify({
            sequence: ++sequence,
            method,
            panel: args[0],
            panels: observed.panels,
          }) + "\n",
        );
        return observed.result;
      });
      return { handled: true, result: await calls };
    },
  };
}
