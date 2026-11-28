import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite-plus";
import { DiHmrPlugin, transformHotModule } from "../../packages/di/src/vite.ts";

type Di = typeof import("../../packages/di/src/index.ts");
type ModuleRunner = { import(url: string): Promise<any> };

export const diPath = fileURLToPath(new URL("../../packages/di/src/index.ts", import.meta.url));
export const variantsPath = fileURLToPath(
  new URL("../../packages/variants/src/index.ts", import.meta.url),
);
const reactivityPath = fileURLToPath(
  new URL("../../packages/di/node_modules/reactivity/dist/index.js", import.meta.url),
);
const hotPath = fileURLToPath(new URL("../../packages/hot/src/index.ts", import.meta.url));
const zodPath = realpathSync(
  fileURLToPath(new URL("../../packages/variants/node_modules/zod", import.meta.url)),
);

export interface DiHmrFixture {
  readonly dir: string;
  readonly server: ViteDevServer;
  readonly runner: ModuleRunner;
  readonly di: Di;
  readonly evals: Record<string, number>;
  file(name: string): string;
  write(name: string, lines: readonly string[]): void;
  /** Writes the file and notifies Vite without waiting for the update. */
  update(name: string, lines: readonly string[]): void;
  load<T = any>(name: string): Promise<T>;
  /** Resolves once no module evaluated for `quietMs`; rejects when evaluations keep going. */
  settle(quietMs?: number, maxMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** A Vite dev server with DiHmrPlugin and an SSR module runner over a fresh temp directory. */
export async function createDiHmrFixture(): Promise<DiHmrFixture> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-di-hmr-")));
  const evals: Record<string, number> = {};
  (globalThis as Record<string, unknown>)["__hmrEvals"] = evals;
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    server: { watch: null },
    oxc: { decorator: { legacy: true } },
    resolve: { alias: { reactivity: reactivityPath, "@harness/hot": hotPath, zod: zodPath } },
    plugins: [
      DiHmrPlugin({
        include: (id) =>
          id.startsWith(dir) &&
          id.endsWith(".ts") &&
          !id.endsWith(".client.ts") &&
          !id.includes("/lib/variants/"),
      }),
      {
        name: "test:client-transform",
        enforce: "post",
        transform: async (code, id) =>
          id.endsWith(".client.ts")
            ? ((await transformHotModule(code, id, { forwardFunctions: false })) ?? null)
            : null,
      },
    ],
  });
  const ssr = server.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("ssr runner unavailable");
  const runner = ssr.runner as ModuleRunner;
  const file = (name: string) => join(dir, name);
  const write = (name: string, lines: readonly string[]) => {
    mkdirSync(dirname(file(name)), { recursive: true });
    writeFileSync(file(name), lines.join("\n"), "utf8");
  };
  return {
    dir,
    server,
    runner,
    di: (await runner.import(diPath)) as Di,
    evals,
    file,
    write,
    update(name, lines) {
      write(name, lines);
      server.watcher.emit("change", file(name));
    },
    load: (name) => runner.import(file(name)),
    async settle(quietMs = 250, maxMs = 8000) {
      const start = Date.now();
      let last = JSON.stringify(evals);
      let since = Date.now();
      while (Date.now() - since < quietMs) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const now = JSON.stringify(evals);
        if (now !== last) {
          last = now;
          since = Date.now();
        }
        if (Date.now() - start > maxMs) throw new Error(`evaluations did not settle: ${now}`);
      }
    },
    async close() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function counted(name: string): string {
  return `globalThis.__hmrEvals[${JSON.stringify(name)}] = (globalThis.__hmrEvals[${JSON.stringify(name)}] ?? 0) + 1;`;
}
