import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("rejects an empty Web database path and accepts explicit in-memory storage", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", "");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, sqlite] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    let scope: ReturnType<typeof web.createServerScope> | undefined;
    try {
      expect(() => {
        scope = web.createServerScope();
      }).toThrow("HARNESS_CHAT_DB must specify a database path when set.");

      vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
      scope = web.createServerScope();
      expect(scope.get(sqlite.SqliteService).read("SELECT 1 AS value")).toEqual([{ value: 1 }]);
    } finally {
      if (scope) {
        const database = scope.get(sqlite.SqliteService);
        scope.dispose();
        await database.close();
      }
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
