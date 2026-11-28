import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Plugin } from "vite-plus";

const workspaceRoot = process.cwd();

function workspaceAliases(): Array<{ find: string | RegExp; replacement: string }> {
  const packagesDir = join(workspaceRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const aliases: Array<{ find: string | RegExp; replacement: string }> = readdirSync(packagesDir, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const replacement = resolve(packagesDir, entry.name, "src/index.ts");
      return existsSync(replacement)
        ? [{ find: new RegExp(`^@harness/${entry.name}$`), replacement }]
        : [];
    });

  // Some packages import shared catalogs without a direct dependency link.
  // Point them at the hoisted virtual-store copy so tests can load the real graph.
  const pnpmStore = join(workspaceRoot, "node_modules/.pnpm");
  const reactivityDir = existsSync(pnpmStore)
    ? readdirSync(pnpmStore).find((entry) => entry.startsWith("@reactive-vscode+reactivity@"))
    : undefined;
  const reactivityCandidates = [
    ...(reactivityDir !== undefined
      ? [join(pnpmStore, reactivityDir, "node_modules/@reactive-vscode/reactivity/dist/index.js")]
      : []),
    join(workspaceRoot, "packages/llm/node_modules/reactivity/dist/index.js"),
  ];
  const reactivity = reactivityCandidates.find((candidate) => existsSync(candidate));
  if (reactivity !== undefined) {
    aliases.push({ find: /^reactivity$/, replacement: reactivity });
  }
  return aliases;
}

const VARIANT_DECORATOR = /@variant\("([^"]+)"\)\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/g;

/**
 * Vite's SSR transform keeps TC39 decorators, which Node cannot parse yet.
 * The production sources only use `@variant("...")` as a side-effecting class
 * decorator, so lower it to an explicit registration in this test-only graph.
 */
function lowerVariantDecorators(code: string, id: string): string | undefined {
  if (!code.includes("@variant(")) return undefined;

  const registrations: string[] = [];
  const transformed = code.replace(
    VARIANT_DECORATOR,
    (_match, name: string, exported: string | undefined, className: string) => {
      registrations.push(`variant(${JSON.stringify(name)})(${className}, {});`);
      return `${exported ?? ""}class ${className}`;
    },
  );
  if (registrations.length === 0) return undefined;
  if (transformed.includes("@variant(")) {
    throw new Error(`Unsupported variant decorator syntax in ${id}`);
  }
  return `${transformed}\n${registrations.join("\n")}\n`;
}

const lowerDecoratorsPlugin: Plugin = {
  name: "nightly-lower-variant-decorators",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/packages/")) return undefined;
    const lowered = lowerVariantDecorators(code, id);
    return lowered === undefined ? undefined : { code: lowered, map: null };
  },
};

export interface HarnessModules {
  load<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

export interface HarnessModulesOptions {
  /** Take precedence over the workspace aliases, e.g. to point `reactivity` at Vue's copy. */
  readonly aliases?: ReadonlyArray<{ find: string | RegExp; replacement: string }>;
}

export async function createHarnessModules(
  options: HarnessModulesOptions = {},
): Promise<HarnessModules> {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: [...(options.aliases ?? []), ...workspaceAliases()] },
    server: { middlewareMode: true, watch: null },
    plugins: [lowerDecoratorsPlugin],
  });
  return {
    load<T>(path: string): Promise<T> {
      return server.ssrLoadModule(path) as Promise<T>;
    },
    close: () => server.close(),
  };
}
