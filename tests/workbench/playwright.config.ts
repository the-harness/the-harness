import { availableParallelism } from "node:os";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.HARNESS_TEST_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  workers: process.env.CI ? Math.min(availableParallelism(), 4) : undefined,
  outputDir: "../../node_modules/.cache/web-test-results",
  use: { baseURL, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `pnpm --filter web exec vp dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    cwd: "../..",
    env: { HARNESS_MOCK_LLM: "1" },
  },
});
