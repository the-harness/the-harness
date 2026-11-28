import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The app's own vite-plus copy, so environments pass the app config's instanceof checks as in `vp dev`.
import { createServer, isRunnableDevEnvironment } from "../../apps/web/node_modules/vite-plus/dist/index.js";
import { createServerModuleLoader } from "../../apps/web/server-modules.ts";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "harness-web-reload-"));
process.env["HARNESS_CHAT_DB"] = join(tempDir, "chat.db");

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("web server full reload", { timeout: 30_000 }, () => {
  it("disposes the previous server scope instead of leaving it running beside the new one", async () => {
    const server = await createServer({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      server: { watch: null, port: 0 },
    });
    try {
      await server.listen();
      const ssr = server.environments.ssr;
      if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("ssr runner unavailable");
      type DevModule = typeof import("../../apps/web/src/server/dev.ts");
      type PresetModule = typeof import("../../packages/agent-preset/src/index.ts");
      const load = () => ssr.runner.import("/src/server/dev.ts") as Promise<DevModule>;
      const presetIds = async (dev: DevModule) => {
        const { AgentPresetRegistry } = (await ssr.runner.import(
          "@harness/agent-preset",
        )) as PresetModule;
        return [...dev.scope.get(AgentPresetRegistry).presets.keys()];
      };

      const first = await load();
      expect(await presetIds(first)).toContain("pi-coding-agent");

      ssr.hot.send({ type: "full-reload" });
      await vi.waitFor(async () => expect(await load()).not.toBe(first));
      expect(first.scope.isDisposed).toBe(true);

      const next = await load();
      expect(next.scope.isDisposed).toBe(false);
      expect(await presetIds(next)).toContain("pi-coding-agent");
    } finally {
      await server.close();
    }
  });

  it("keeps serving the same scope after an update invalidates the server entry", async () => {
    const server = await createServer({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      server: { watch: null, port: 0 },
    });
    try {
      await server.listen();
      const ssr = server.environments.ssr;
      if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("ssr runner unavailable");
      type DevModule = typeof import("../../apps/web/src/server/dev.ts");
      const load = createServerModuleLoader(server);
      const first = await load<DevModule>("/src/server/dev.ts");

      // What Vite does to the importers of a hot-updated module, which the runner has applied.
      const entry = await ssr.moduleGraph.getModuleByUrl("/src/server/dev.ts");
      ssr.moduleGraph.invalidateModule(entry!);

      const next = await load<DevModule>("/src/server/dev.ts");
      expect(next.scope).toBe(first.scope);
      expect(first.scope.isDisposed).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects every load of a server module whose evaluation threw instead of serving its partial exports", async () => {
    const root = mkdtempSync(join(tempDir, "throwing-"));
    writeFileSync(
      join(root, "broken.ts"),
      'export const before = 1;\nthrow new Error("broken module evaluation");\nexport const after = 2;\n',
    );
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { watch: null, middlewareMode: true, hmr: false },
    });
    try {
      const load = createServerModuleLoader(server);
      await expect(load("/broken.ts")).rejects.toThrow("broken module evaluation");
      await expect(load("/broken.ts")).rejects.toThrow("broken module evaluation");
    } finally {
      await server.close();
    }
  });
});
