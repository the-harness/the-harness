import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vite-plus/test";
import type { Scope } from "../../packages/di/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("disposes the server root scope when its setup throws", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", join(tmpdir(), "harness-missing-secret-key"));
  try {
    const [web, di] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
    ]);
    const created: Scope[] = [];
    const createRoot = di.Scope.createRoot.bind(di.Scope);
    const spy = vi.spyOn(di.Scope, "createRoot").mockImplementation((options) => {
      const root = createRoot(options);
      created.push(root);
      return root;
    });
    try {
      expect(() => web.createServerScope()).toThrow(/ENOENT/);
    } finally {
      spy.mockRestore();
    }
    expect(created).toHaveLength(1);
    expect(created[0]!.isDisposed).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
