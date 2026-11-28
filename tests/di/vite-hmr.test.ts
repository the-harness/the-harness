import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DiHmrPlugin, transformHotModule } from "../../packages/di/src/vite.ts";

type Di = typeof import("../../packages/di/src/index.ts");
type ModuleRunner = { import(url: string): Promise<any> };

const diPath = fileURLToPath(new URL("../../packages/di/src/index.ts", import.meta.url));
const variantsPath = fileURLToPath(
  new URL("../../packages/variants/src/index.ts", import.meta.url),
);
const reactivityPath = fileURLToPath(
  new URL("../../packages/di/node_modules/reactivity/dist/index.js", import.meta.url),
);
const variantsSrc = fileURLToPath(new URL("../../packages/variants/src/", import.meta.url));
const hotPath = fileURLToPath(new URL("../../packages/hot/src/index.ts", import.meta.url));
const zodPath = realpathSync(
  fileURLToPath(new URL("../../packages/variants/node_modules/zod", import.meta.url)),
);

interface Fixture {
  readonly server: ViteDevServer;
  readonly runner: ModuleRunner;
  readonly di: Di;
  readonly evals: Record<string, number>;
  file(name: string): string;
  write(name: string, lines: readonly string[]): void;
  update(name: string, lines: readonly string[]): Promise<void>;
  load<T = any>(name: string): Promise<T>;
}

let fixture: Fixture;
let tempDir: string;

beforeEach(async () => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "harness-di-hmr-")));
  const evals: Record<string, number> = {};
  (globalThis as Record<string, unknown>)["__hmrEvals"] = evals;
  const server = await createServer({
    root: tempDir,
    configFile: false,
    logLevel: "silent",
    server: { watch: null },
    oxc: { decorator: { legacy: true } },
    resolve: { alias: { reactivity: reactivityPath, "@harness/hot": hotPath, zod: zodPath } },
    plugins: [
      DiHmrPlugin({
        include: (id) =>
          id.startsWith(tempDir) &&
          id.endsWith(".ts") &&
          !id.endsWith(".client.ts") &&
          !id.includes("/lib/variants/") &&
          !id.includes("/plain/"),
      }),
      {
        // The client transform, run in the SSR runner because client modules are not runnable here.
        name: "test:client-transform",
        enforce: "post",
        async transform(code, id) {
          if (!id.endsWith(".client.ts")) return null;
          const resolve = async (source: string) => (await this.resolve(source, id))?.id;
          return (await transformHotModule(code, id, { forwardFunctions: false, resolve })) ?? null;
        },
      },
    ],
  });
  const ssr = server.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("ssr runner unavailable");
  const runner = ssr.runner as ModuleRunner;

  const file = (name: string) => join(tempDir, name);
  const write = (name: string, lines: readonly string[]) => {
    mkdirSync(dirname(file(name)), { recursive: true });
    writeFileSync(file(name), lines.join("\n"), "utf8");
  };
  fixture = {
    server,
    runner,
    di: (await runner.import(diPath)) as Di,
    evals,
    file,
    write,
    async update(name, lines) {
      write(name, lines);
      server.watcher.emit("change", file(name));
    },
    load: (name) => runner.import(file(name)),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const imports = [
  `import { inject } from ${JSON.stringify(diPath)};`,
  `import { onScopeDispose, shallowReactive } from "reactivity";`,
];

function counted(name: string): string {
  return `globalThis.__hmrEvals[${JSON.stringify(name)}] = (globalThis.__hmrEvals[${JSON.stringify(name)}] ?? 0) + 1;`;
}

function writeRegistry(): void {
  fixture.write("registry.ts", [
    ...imports,
    "export class Registry {",
    "  items = shallowReactive([]);",
    "  add(item) {",
    "    this.items.push(item);",
    "    onScopeDispose(() => this.items.splice(this.items.indexOf(item), 1));",
    "  }",
    "}",
  ]);
}

function toolModule(label: string): string[] {
  return [
    ...imports,
    `import { Registry } from "./registry.ts";`,
    counted("tools"),
    `function label() { return ${JSON.stringify(label)}; }`,
    "export function useTool() { inject(Registry).add(`tool:${label()}`); }",
    "export const useArrow = () => inject(Registry).add(`arrow:${label()}`);",
    "function aliased() { inject(Registry).add(`alias:${label()}`); }",
    "export { aliased as useAlias };",
    "export default function useDefault() { inject(Registry).add(`default:${label()}`); }",
  ];
}

async function setupTools() {
  writeRegistry();
  fixture.write("tools.ts", toolModule("v1"));
  const { Registry } = await fixture.load("registry.ts");
  const tools = await fixture.load("tools.ts");
  const root = fixture.di.createRootScope();
  root.provide(Registry);
  root.setup(() => {
    tools.useTool();
    tools.useArrow();
    tools.useAlias();
    tools.default();
  });
  return { root, tools, registry: root.get(Registry) as { items: string[] } };
}

describe("DiHmrPlugin function exports", () => {
  it("re-runs setups that called updated exports while keeping forwarders stable", async () => {
    const { root, tools, registry } = await setupTools();
    expect([...registry.items]).toEqual(["tool:v1", "arrow:v1", "alias:v1", "default:v1"]);

    await fixture.update("tools.ts", toolModule("v2"));
    await vi.waitFor(() =>
      expect([...registry.items]).toEqual(["tool:v2", "arrow:v2", "alias:v2", "default:v2"]),
    );

    const next = await fixture.load("tools.ts");
    expect(next.useTool).toBe(tools.useTool);
    expect(next.useArrow).toBe(tools.useArrow);
    expect(next.useAlias).toBe(tools.useAlias);
    expect(next.default).toBe(tools.default);
    expect(fixture.evals["tools"]).toBe(2);
    root.dispose();
  });

  it("keeps the previous version when the new module fails to evaluate", async () => {
    const { root, registry } = await setupTools();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("tools.ts", [...toolModule("v2"), "throw new Error('broken module');"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([...registry.items]).toEqual(["tool:v1", "arrow:v1", "alias:v1", "default:v1"]);

    await fixture.update("tools.ts", toolModule("v3"));
    await vi.waitFor(() =>
      expect([...registry.items]).toEqual(["tool:v3", "arrow:v3", "alias:v3", "default:v3"]),
    );
    root.dispose();
  });

  it("rolls back to the previous implementation when a re-run setup throws", async () => {
    const { root, tools, registry } = await setupTools();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update(
      "tools.ts",
      toolModule("v2").map((line) =>
        line.startsWith("export function useTool")
          ? "export function useTool() { throw new Error('broken setup'); }"
          : line,
      ),
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect([...registry.items]).toEqual(["tool:v1", "arrow:v1", "alias:v1", "default:v1"]);
    expect(() => tools.useArrow.call(undefined)).toThrow();

    await fixture.update("tools.ts", toolModule("v3"));
    await vi.waitFor(() =>
      expect([...registry.items]).toEqual(["tool:v3", "arrow:v3", "alias:v3", "default:v3"]),
    );
    root.dispose();
  });
});

describe("DiHmrPlugin update batches", () => {
  it("retries a rejected update together with the change that completes it", async () => {
    writeRegistry();
    fixture.write("lib.ts", ['export function label() { return "v1"; }']);
    const tool = (call: string, name: string) => [
      ...imports,
      `import { Registry } from "./registry.ts";`,
      `import { ${name} } from "./lib.ts";`,
      `export function useTool() { inject(Registry).add(\`tool:\${${call}}\`); }`,
    ];
    fixture.write("tool.ts", tool("label()", "label"));
    const { Registry } = await fixture.load("registry.ts");
    const { useTool } = await fixture.load("tool.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.setup(() => useTool());
    const registry = root.get(Registry) as { items: string[] };
    expect([...registry.items]).toEqual(["tool:v1"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("tool.ts", tool("title()", "title"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect([...registry.items]).toEqual(["tool:v1"]);

    await fixture.update("lib.ts", ['export function title() { return "v2"; }']);
    await vi.waitFor(() => expect([...registry.items]).toEqual(["tool:v2"]));
    root.dispose();
  });

  it("keeps exported function variables that module code reassigns as values", async () => {
    const module = (label: string) => [
      'export let handler = () => "init";',
      `handler = () => "${label}";`,
    ];
    fixture.write("reassigned.ts", module("v1"));
    fixture.write("reassigned-user.ts", [
      `import { handler } from "./reassigned.ts";`,
      "export function call() { return handler(); }",
    ]);
    const user = await fixture.load("reassigned-user.ts");
    expect(user.call()).toBe("v1");
    await fixture.update("reassigned.ts", module("v2"));
    await vi.waitFor(() => expect(user.call()).toBe("v2"));
  });

  it("forwards function variables declared together with their users", async () => {
    fixture.write("declarators.ts", [
      "export const first = () => 1, list = [first];",
      "export function includesFirst() { return list.includes(first); }",
    ]);
    const mod = await fixture.load("declarators.ts");
    expect(mod.includesFirst()).toBe(true);
    expect(mod.first.name).toBe("first");
  });

  it("rejects a batch once however many modules were updated before", async () => {
    const module = (name: string, body: string) => [`export function ${name}() { ${body} }`];
    fixture.write("a.ts", module("useA", ""));
    fixture.write("b.ts", module("useB", ""));
    fixture.write("c.ts", module("useC", ""));
    const [a, b, c] = await Promise.all(["a.ts", "b.ts", "c.ts"].map((name) => fixture.load(name)));
    const root = fixture.di.createRootScope();
    root.setup(() => {
      a.useA();
      b.useB();
      c.useC();
    });
    await fixture.update("a.ts", module("useA", "void 1;"));
    await fixture.update("c.ts", module("useC", "void 1;"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("b.ts", module("useB", 'throw new Error("broken");'));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors).toHaveBeenCalledTimes(1);
    root.dispose();
  });

  it("applies a module re-evaluated outside an update", async () => {
    fixture.write("label.ts", ['export function label() { return "v1"; }']);
    fixture.write("user.ts", [
      `import { label } from "./label.ts";`,
      counted("user"),
      "const evaluation = globalThis.__hmrEvals.user;",
      "export function describe() { return `${label()}:${evaluation}`; }",
    ]);
    await fixture.load("user.ts");
    await fixture.update("label.ts", ['export function label() { return "v2"; }']);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Invalidated on the server, it is evaluated again when imported next.
    const graph = fixture.server.environments.ssr!.moduleGraph;
    graph.invalidateModule(graph.getModuleById(fixture.file("user.ts"))!);
    const next = await fixture.load("user.ts");
    expect(fixture.evals["user"]).toBe(2);
    expect(next.describe()).toBe("v2:2");
  });

  it("does not apply an update superseded by an evaluation that throws", async () => {
    const module = (version: string, fail = false) => [
      `export function version() { if (globalThis.__rejectV2 && "${version}" === "v2") throw new Error("rejected"); return "${version}"; }`,
      ...(fail ? ['throw new Error("top-level failure");'] : []),
    ];
    fixture.write("versioned.ts", module("v1"));
    fixture.write("other.ts", ["export function other() { return 1; }"]);
    const versioned = await fixture.load("versioned.ts");
    await fixture.load("other.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => void versioned.version());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as Record<string, unknown>)["__rejectV2"] = true;

    await fixture.update("versioned.ts", module("v2"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    (globalThis as Record<string, unknown>)["__rejectV2"] = false;
    await fixture.update("versioned.ts", module("v3", true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.update("other.ts", ["export function other() { return 2; }"]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(versioned.version()).toBe("v1");
    root.dispose();
  });

  it("does not apply an update superseded by an evaluation whose import throws", async () => {
    const module = (version: string, imports: string[] = []) => [
      ...imports,
      `export function version() { if (globalThis.__rejectV2 && "${version}" === "v2") throw new Error("rejected"); return "${version}"; }`,
    ];
    fixture.write("boom.ts", ['throw new Error("import failed");']);
    fixture.write("versioned-import.ts", module("v1"));
    fixture.write("other-import.ts", ["export function other() { return 1; }"]);
    const versioned = await fixture.load("versioned-import.ts");
    await fixture.load("other-import.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => void versioned.version());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as Record<string, unknown>)["__rejectV2"] = true;

    await fixture.update("versioned-import.ts", module("v2"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    (globalThis as Record<string, unknown>)["__rejectV2"] = false;
    await fixture.update("versioned-import.ts", module("v3", ['import "./boom.ts";']));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.update("other-import.ts", ["export function other() { return 2; }"]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(versioned.version()).toBe("v1");
    errors.mockRestore();
    root.dispose();
  });
});

describe("DiHmrPlugin value exports", () => {
  function configModule(limit: number, body: string, extra: string[] = []): string[] {
    return [
      counted("config"),
      `export const LIMIT = ${limit};`,
      `export function describeLimit() { return ${body}; }`,
      ...extra,
    ];
  }

  async function setupConfig() {
    fixture.write("config.ts", configModule(1, "'a'"));
    fixture.write("user.ts", [
      `import { LIMIT, describeLimit } from "./config.ts";`,
      counted("user"),
      "export function read() { return `${LIMIT}:${describeLimit()}`; }",
    ]);
    const user = await fixture.load("user.ts");
    expect(user.read()).toBe("1:a");
    return user;
  }

  it("does not re-evaluate importers when values are unchanged", async () => {
    const user = await setupConfig();
    await fixture.update("config.ts", configModule(1, "'b'"));
    await vi.waitFor(() => expect(user.read()).toBe("1:b"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals["user"]).toBe(1);
  });

  it("re-evaluates importers when a value changes", async () => {
    const user = await setupConfig();
    await fixture.update("config.ts", configModule(2, "'a'"));
    await vi.waitFor(() => expect(fixture.evals["user"]).toBe(2));
    expect((await fixture.load("user.ts")).read()).toBe("2:a");
    expect(user.read).toBe((await fixture.load("user.ts")).read);
  });

  it("re-evaluates only importers of names added to or removed from the export list", async () => {
    await setupConfig();
    fixture.write("reader.ts", [
      `import { added } from "./config.ts";`,
      counted("reader"),
      "export function read() { return added === undefined ? 'missing' : added(); }",
    ]);
    const reader = await fixture.load("reader.ts");
    expect(reader.read()).toBe("missing");

    await fixture.update("config.ts", configModule(1, "'a'", ["export function added() { return 'added'; }"]));
    await vi.waitFor(() => expect(reader.read()).toBe("added"));
    await fixture.update("config.ts", configModule(1, "'a'"));
    await vi.waitFor(() => expect(reader.read()).toBe("missing"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals["reader"]).toBe(3);
    expect(fixture.evals["user"]).toBe(1);
  });

  it("re-evaluates only importers of the changed name behind a barrel, keeping other services", async () => {
    fixture.write("base.ts", [counted("base"), "export class Base { readonly id = Math.random(); }"]);
    const barrel = (value: number) => [
      'export * from "./base.ts";',
      counted("barrel"),
      `export const BARREL = ${value};`,
    ];
    fixture.write("barrel.ts", barrel(0));
    fixture.write("sub.ts", [
      `import { Base } from "./barrel.ts";`,
      counted("sub"),
      "export class Sub extends Base {}",
    ]);
    fixture.write("reader.ts", [
      `import { BARREL } from "./barrel.ts";`,
      counted("reader"),
      "export function read() { return BARREL; }",
    ]);
    fixture.write("entry.ts", ['import "./sub.ts";', 'import "./reader.ts";', "export function entry() {}"]);
    await fixture.load("entry.ts");
    const [base, sub, reader] = await Promise.all(["base.ts", "sub.ts", "reader.ts"].map((name) => fixture.load(name)));
    const root = fixture.di.createRootScope();
    root.provide(base.Base, sub.Sub);
    const instance = root.get(base.Base);

    await fixture.update("barrel.ts", barrel(1));
    await vi.waitFor(() => expect(reader.read()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals).toMatchObject({ base: 1, barrel: 2, sub: 1, reader: 2 });
    expect(root.get(base.Base)).toBe(instance);
    root.dispose();
  });

  it("re-evaluates importers outside the instrumentation and dynamic importers of a changed value", async () => {
    await setupConfig();
    fixture.write("plain/reader.ts", [
      `import { LIMIT } from "../config.ts";`,
      counted("plain"),
      "globalThis.__plainLimit = () => LIMIT;",
    ]);
    fixture.write("lazy.ts", [
      counted("lazy"),
      "let config;",
      'export async function load() { config = await import("./config.ts"); }',
      "export function read() { return config.LIMIT; }",
    ]);
    await fixture.load("plain/reader.ts");
    const lazy = await fixture.load("lazy.ts");
    await lazy.load();
    await fixture.update("config.ts", configModule(2, "'a'"));
    const limit = () => (globalThis as Record<string, () => number>)["__plainLimit"]!();
    await vi.waitFor(() => expect(limit()).toBe(2));
    await vi.waitFor(() => expect(fixture.evals["lazy"]).toBe(2));
  });

  it("stops re-evaluating an import cycle whose values keep changing", async () => {
    const a = (value: number) => [
      `import { B } from "./cycle-b.ts";`,
      counted("cycleA"),
      `export const A = new Map([["v", ${value}]]);`,
      "export function readB() { return B; }",
    ];
    fixture.write("cycle-a.ts", a(1));
    fixture.write("cycle-b.ts", [
      `import { A } from "./cycle-a.ts";`,
      counted("cycleB"),
      "export const B = new Map();",
      "export function readA() { return A; }",
    ]);
    const b = await fixture.load("cycle-b.ts");
    await fixture.update("cycle-a.ts", a(2));
    await vi.waitFor(async () => expect((await fixture.load("cycle-b.ts")).readA().get("v")).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settled = { ...fixture.evals };
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fixture.evals).toEqual(settled);
    expect(settled["cycleA"]).toBeLessThanOrEqual(4);
    expect(b).toBeDefined();
  });

  it("does not evaluate importers again on a later import after an update", async () => {
    fixture.write("leaf.ts", ["export function leaf() { return 1; }"]);
    fixture.write("mid.ts", [`import { leaf } from "./leaf.ts";`, counted("mid"), "export function mid() { return leaf(); }"]);
    fixture.write("top.ts", [`import { mid } from "./mid.ts";`, counted("top"), "export function top() { return mid(); }"]);
    const top = await fixture.load("top.ts");
    await fixture.update("leaf.ts", ["export function leaf() { return 2; }"]);
    await vi.waitFor(() => expect(top.top()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.load("top.ts");
    await fixture.load("mid.ts");
    expect(fixture.evals).toMatchObject({ mid: 1, top: 1 });
  });

  it("evaluates a module below a failed update again once it is fixed", async () => {
    const flags = globalThis as Record<string, unknown>;
    fixture.write("plain/leaf.ts", ["export const LEAF = 1;"]);
    const first = (label: string) => [
      `import { LEAF } from "./leaf.ts";`,
      `if (globalThis.__breakFirst) throw new Error("broken ${label}");`,
      "export const FIRST = LEAF;",
    ];
    fixture.write("plain/first.ts", first("v1"));
    fixture.write("plain/mid.ts", [`import { LEAF } from "./leaf.ts";`, "export const MID = LEAF;"]);
    fixture.write("top.ts", [
      `import { FIRST } from "./plain/first.ts";`,
      `import { MID } from "./plain/mid.ts";`,
      "export function read() { return `${FIRST}:${MID}`; }",
    ]);
    expect((await fixture.load("top.ts")).read()).toBe("1:1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // The update stops at the first import of the top module, before reaching the second.
    flags["__breakFirst"] = true;
    await fixture.update("plain/leaf.ts", ["export const LEAF = 2;"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    flags["__breakFirst"] = false;
    await fixture.update("plain/first.ts", first("v2"));
    await vi.waitFor(async () => expect((await fixture.load("top.ts")).read()).toBe("2:2"));
  });
});

describe("DiHmrPlugin class exports", () => {
  function greeterModule(version: string): string[] {
    return [counted("greeter"), "export class Greeter {", `  greet() { return "${version}"; }`, "}"];
  }

  it("rebuilds services, cascades to dependents and re-binds importers", async () => {
    fixture.write("greeter.ts", greeterModule("v1"));
    fixture.write("consumer.ts", [
      ...imports,
      `import { Greeter } from "./greeter.ts";`,
      counted("consumer"),
      "export class Consumer {",
      "  greeter = inject(Greeter);",
      "  say() { return this.greeter.greet(); }",
      "}",
      "export function greeterClass() { return Greeter; }",
    ]);
    fixture.write("entry.ts", [
      `import { Consumer } from "./consumer.ts";`,
      counted("entry"),
      "export function consumerClass() { return Consumer; }",
    ]);
    await fixture.load("entry.ts");
    const { Greeter } = await fixture.load("greeter.ts");
    const consumerModule = await fixture.load("consumer.ts");
    const root = fixture.di.createRootScope();
    root.provideAll([Greeter, consumerModule.Consumer]);
    const before = root.get(consumerModule.Consumer);
    expect(before.say()).toBe("v1");

    await fixture.update("greeter.ts", greeterModule("v2"));
    await vi.waitFor(() => expect(fixture.evals["entry"]).toBe(2));
    expect(fixture.evals["consumer"]).toBe(2);
    expect(await fixture.runner.import(diPath)).toBe(fixture.di);

    const after = root.get(consumerModule.Consumer);
    expect(after).not.toBe(before);
    expect(after.say()).toBe("v2");
    const nextConsumer = await fixture.load("consumer.ts");
    expect(root.get(nextConsumer.Consumer)).toBe(after);
    expect(root.get(consumerModule.greeterClass())).toBe(after.greeter);
    expect(after.greeter).toBeInstanceOf(consumerModule.greeterClass());
    root.dispose();
  });

  it("re-evaluates only importers that use a replaced class beyond DI", async () => {
    fixture.write("greeter.ts", greeterModule("v1"));
    fixture.write("injecting.ts", [
      ...imports,
      `import { Greeter } from "./greeter.ts";`,
      counted("injecting"),
      "export class Injecting { greeter = inject(Greeter); }",
    ]);
    fixture.write("extending.ts", [
      `import { Greeter } from "./greeter.ts";`,
      counted("extending"),
      "export class Loud extends Greeter { greet() { return super.greet().toUpperCase(); } }",
    ]);
    fixture.write("entry.ts", [
      `import "./injecting.ts";`,
      `import "./extending.ts";`,
      "export function noop() {}",
    ]);
    await fixture.load("entry.ts");
    const { Greeter } = await fixture.load("greeter.ts");
    const { Injecting } = await fixture.load("injecting.ts");
    const { Loud } = await fixture.load("extending.ts");
    const root = fixture.di.createRootScope();
    root.provideAll([Greeter, Injecting]);
    const child = root.createChild();
    child.provide(Loud);
    const injecting = root.get(Injecting);
    expect(child.get(Greeter).greet()).toBe("V1");

    await fixture.update("greeter.ts", greeterModule("v2"));
    await vi.waitFor(() => expect(child.get(Greeter).greet()).toBe("V2"));
    expect(fixture.evals["extending"]).toBe(2);
    expect(fixture.evals["injecting"]).toBe(1);
    expect(root.get(Injecting)).not.toBe(injecting);
    expect(root.get(Injecting).greeter.greet()).toBe("v2");
    root.dispose();
  });

  it("rebuilds service instances when a function of their module changes", async () => {
    const module = (label: string) => [
      ...imports,
      counted("service"),
      "export class Service { readonly createdAt = Math.random(); }",
      `export function describeService() { return "${label}"; }`,
    ];
    fixture.write("service.ts", module("v1"));
    const service = await fixture.load("service.ts");
    const root = fixture.di.createRootScope();
    root.provide(service.Service);
    const instance = root.get(service.Service);

    await fixture.update("service.ts", module("v2"));
    await vi.waitFor(() => expect(service.describeService()).toBe("v2"));
    expect(fixture.evals["service"]).toBe(2);
    expect(root.get(service.Service)).not.toBe(instance);
    root.dispose();
  });

  it("restores the previous implementation when the new constructor throws", async () => {
    fixture.write("greeter.ts", greeterModule("v1"));
    const { Greeter } = await fixture.load("greeter.ts");
    const root = fixture.di.createRootScope();
    root.provide(Greeter);
    const before = root.get(Greeter);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("greeter.ts", [
      "export class Greeter {",
      "  constructor() { throw new Error('broken constructor'); }",
      "}",
    ]);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(root.get(Greeter)).toBeInstanceOf(Greeter);
    expect(root.get(Greeter).greet()).toBe("v1");
    expect(before.greet()).toBe("v1");

    await fixture.update("greeter.ts", greeterModule("v3"));
    await vi.waitFor(() => expect(root.get(Greeter).greet()).toBe("v3"));
    root.dispose();
  });

  it("decorates a re-evaluated class once", async () => {
    const module = (label: string) => [
      "function bang(target, key, descriptor) { const inner = descriptor.value; descriptor.value = function () { return inner.call(this) + '!'; }; }",
      "function tag(target) { target.tagged = (target.tagged ?? 0) + 1; }",
      "@tag",
      "export class Svc { @bang hello() { return 'x'; } }",
      `export function describe() { return "${label}"; }`,
    ];
    fixture.write("decorated.ts", module("v1"));
    const mod = await fixture.load("decorated.ts");
    await fixture.update("decorated.ts", module("v2"));
    await vi.waitFor(() => expect(mod.describe()).toBe("v2"));
    const next = await fixture.load("decorated.ts");
    expect(next.Svc).not.toBe(mod.Svc);
    expect(new next.Svc().hello()).toBe("x!");
    expect(next.Svc.tagged).toBe(1);
  });

  it("replaces legacy-decorated classes", async () => {
    const decorated = (version: string) => [
      "function tag(target) { target.tagged = true; }",
      "@tag",
      "export class Tagged {",
      `  version() { return "${version}"; }`,
      "}",
    ];
    fixture.write("tagged.ts", decorated("v1"));
    const { Tagged } = await fixture.load("tagged.ts");
    expect(Tagged.tagged).toBe(true);
    const root = fixture.di.createRootScope();
    root.provide(Tagged);

    await fixture.update("tagged.ts", decorated("v2"));
    await vi.waitFor(() => expect(root.get(Tagged).version()).toBe("v2"));
    expect(root.get(Tagged).constructor.tagged).toBe(true);
    root.dispose();
  });
});

describe("client transform", () => {
  it("replaces classes through DI and lets function updates propagate to importers", async () => {
    fixture.write("greeter.client.ts", [
      counted("greeter"),
      "export class Greeter {",
      '  greet() { return "v1"; }',
      "}",
    ]);
    fixture.write("format.client.ts", ["export function format(value) { return `[${value}]`; }"]);
    fixture.write("view.client.ts", [
      `import { Greeter } from "./greeter.client.ts";`,
      `import { format } from "./format.client.ts";`,
      counted("view"),
      "export function render(greeter) { return format(greeter.greet()); }",
      "export function greeterClass() { return Greeter; }",
    ]);
    fixture.write("component.client.ts", [
      `import { render } from "./view.client.ts";`,
      counted("component"),
      "export const component = { render };",
      "if (import.meta.hot) import.meta.hot.accept();",
    ]);
    await fixture.load("component.client.ts");
    const view = await fixture.load("view.client.ts");
    const root = fixture.di.createRootScope();
    root.provide(view.greeterClass());
    expect(view.render(root.get(view.greeterClass()))).toBe("[v1]");

    await fixture.update("greeter.client.ts", [
      counted("greeter"),
      "export class Greeter {",
      '  greet() { return "v2"; }',
      "}",
    ]);
    await vi.waitFor(() => expect(view.render(root.get(view.greeterClass()))).toBe("[v2]"));
    // The view holds the class: it is evaluated again, and so is the component holding its render.
    await vi.waitFor(() => expect(fixture.evals["component"]).toBe(2));
    expect(fixture.evals["view"]).toBe(2);

    await fixture.update("format.client.ts", ["export function format(value) { return `<${value}>`; }"]);
    await vi.waitFor(() => expect(fixture.evals["component"]).toBe(3));
    expect(fixture.evals["view"]).toBe(3);
    expect(fixture.evals["greeter"]).toBe(2);
    const nextView = await fixture.load("view.client.ts");
    expect(nextView.render).not.toBe(view.render);
    expect(nextView.render(root.get(view.greeterClass()))).toBe("<v2>");
    root.dispose();
  });
});

describe("DiHmrPlugin re-exports", () => {
  for (const [name, barrel] of [
    ["export *", ['export * from "./reexport-base.ts";']],
    ["a named re-export", ['export { Base as Renamed } from "./reexport-base.ts";']],
    ["an imported binding exported again", ['import { Base } from "./reexport-base.ts";', "export { Base as Renamed };"]],
  ] as const) {
    it(`re-binds importers of a barrel using ${name}`, async () => {
      const base = (value: number) => [`export class Base { value() { return ${value}; } }`];
      const imported = name === "export *" ? "Base" : "Renamed";
      fixture.write("reexport-base.ts", base(1));
      fixture.write("reexport-index.ts", [...barrel]);
      fixture.write("reexport-sub.ts", [
        `import { ${imported} } from "./reexport-index.ts";`,
        `export class Sub extends ${imported} {}`,
        "export function make() { return new Sub().value(); }",
      ]);
      const sub = await fixture.load("reexport-sub.ts");
      expect(sub.make()).toBe(1);
      await fixture.update("reexport-base.ts", base(2));
      await vi.waitFor(() => expect(sub.make()).toBe(2));
    });
  }
});

describe("DiHmrPlugin barrel bindings", () => {
  it("re-binds importers of a barrel when a re-exported value changes", async () => {
    fixture.write("bv-base.ts", ["export const LIMIT = 1;"]);
    fixture.write("bv-index.ts", ['export * from "./bv-base.ts";']);
    fixture.write("bv-user.ts", [
      `import { LIMIT } from "./bv-index.ts";`,
      "export function read() { return LIMIT; }",
    ]);
    const user = await fixture.load("bv-user.ts");
    expect(user.read()).toBe(1);
    await fixture.update("bv-base.ts", ["export const LIMIT = 2;"]);
    await vi.waitFor(() => expect(user.read()).toBe(2));
  });

  it("re-binds importers of a barrel when a re-exported alias points elsewhere", async () => {
    const base = (local: string) => [
      'function a() { return "a"; }',
      'function b() { return "b"; }',
      `export { ${local} as pick };`,
    ];
    fixture.write("ba-base.ts", base("a"));
    fixture.write("ba-index.ts", ['export { pick } from "./ba-base.ts";']);
    fixture.write("ba-user.ts", [
      `import { pick } from "./ba-index.ts";`,
      "export function call() { return pick(); }",
    ]);
    const user = await fixture.load("ba-user.ts");
    expect(user.call()).toBe("a");
    await fixture.update("ba-base.ts", base("b"));
    await vi.waitFor(() => expect(user.call()).toBe("b"));
  });
});

describe("DiHmrPlugin cycles and barrels", () => {
  it("re-binds importers of a barrel when two of its sources change together", async () => {
    fixture.write("lib/variants/shared.ts", ["export const N = 1;"]);
    fixture.write("t1-a.ts", ['import { N } from "./lib/variants/shared.ts";', "export const A = N;"]);
    fixture.write("t1-b.ts", ['import { N } from "./lib/variants/shared.ts";', "export const B = N * 10;"]);
    fixture.write("t1-index.ts", ['export * from "./t1-a.ts";', 'export * from "./t1-b.ts";']);
    fixture.write("t1-ua.ts", ['import { A } from "./t1-index.ts";', "export function read() { return A; }"]);
    fixture.write("t1-ub.ts", ['import { B } from "./t1-index.ts";', "export function read() { return B; }"]);
    const ua = await fixture.load("t1-ua.ts");
    const ub = await fixture.load("t1-ub.ts");
    expect([ua.read(), ub.read()]).toEqual([1, 10]);
    await fixture.update("lib/variants/shared.ts", ["export const N = 2;"]);
    await new Promise((r) => setTimeout(r, 600));
    expect([ua.read(), ub.read()]).toEqual([2, 20]);
  });

  it("does not re-evaluate an import cycle of classes endlessly", async () => {
    fixture.write("t4-x.ts", [
      counted("x"),
      'import { U } from "./t4-u.ts";',
      "export class X { v() { return 1; } u() { return U; } }",
    ]);
    fixture.write("t4-u.ts", [
      counted("u"),
      'import { X } from "./t4-x.ts";',
      "export class U { x() { return X; } }",
    ]);
    const u = await fixture.load("t4-u.ts");
    await fixture.update("t4-x.ts", [
      counted("x"),
      'import { U } from "./t4-u.ts";',
      "export class X { v() { return 2; } u() { return U; } }",
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    const evals = { ...fixture.evals };
    await new Promise((r) => setTimeout(r, 1000));
    expect(fixture.evals).toEqual(evals);
    expect(fixture.evals["x"]).toBeLessThan(5);
  });

  it("does not invalidate an import cycle endlessly for plain data exports", async () => {
    fixture.write("t6-x.ts", [counted("x"), 'import { read } from "./t6-u.ts";', "export const config = { v: 1 };", "export function viaU() { return read(); }"]);
    fixture.write("t6-u.ts", [counted("u"), 'import { config } from "./t6-x.ts";', "export function read() { return config.v; }"]);
    const x = await fixture.load("t6-x.ts");
    expect(x.viaU()).toBe(1);
    await fixture.update("t6-x.ts", [counted("x"), 'import { read } from "./t6-u.ts";', "export const config = { v: 2 };", "export function viaU() { return read(); }"]);
    await new Promise((r) => setTimeout(r, 1500));
    const evals = { ...fixture.evals };
    await new Promise((r) => setTimeout(r, 1000));
    expect(fixture.evals).toEqual(evals);
    expect(x.viaU()).toBe(2);
  });

  it("re-binds importers when a barrel switches one of several export * sources", async () => {
    fixture.write("t7-a.ts", ['export const V = "a";']);
    fixture.write("t7-0.ts", ['export const V = "0";']);
    fixture.write("t7-z.ts", ['export const Z = "z";']);
    fixture.write("t7-b.ts", ['export * from "./t7-a.ts";', 'export * from "./t7-z.ts";']);
    fixture.write("t7-u.ts", ['import { V } from "./t7-b.ts";', "export function read() { return V; }"]);
    const u = await fixture.load("t7-u.ts");
    expect(u.read()).toBe("a");
    await fixture.update("t7-b.ts", ['export * from "./t7-0.ts";', 'export * from "./t7-z.ts";']);
    await new Promise((r) => setTimeout(r, 800));
    expect(u.read()).toBe("0");
  });
});

describe("DiHmrPlugin re-binding order", () => {
  async function retriedBatch(steps: Array<readonly [string, string[]]>) {
    const tool = (label: string) => [
      `export function useTool() { if (globalThis.__breakTool) throw new Error("broken ${label}"); }`,
    ];
    const base = (label: string) => [`export class Base { label() { return "${label}"; } }`];
    const sub = (label: string) => [
      `import { Base } from "./order-base.ts";`,
      `export class Sub extends Base { sub() { return "${label}"; } }`,
      "export function make() { return new Sub().label(); }",
    ];
    fixture.write("order-tool.ts", tool("v1"));
    fixture.write("order-base.ts", base("b1"));
    fixture.write("order-sub.ts", sub("s1"));
    const [toolModule, , subModule] = await Promise.all(
      ["order-tool.ts", "order-base.ts", "order-sub.ts"].map((name) => fixture.load(name)),
    );
    const root = fixture.di.createRootScope();
    root.setup(() => toolModule.useTool());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flags = globalThis as Record<string, unknown>;
    flags["__breakTool"] = true;
    await fixture.update("order-tool.ts", tool("v2"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    const sources = { base, sub } as Record<string, (label: string) => string[]>;
    for (const [file, label] of steps) {
      await fixture.update(`order-${file}.ts`, sources[file]!(label[0]!));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    flags["__breakTool"] = false;
    await fixture.update("order-tool.ts", tool("v3"));
    errors.mockRestore();
    return { root, subModule };
  }

  it("re-binds a subclass evaluated before its base in a retried batch", async () => {
    const { root, subModule } = await retriedBatch([
      ["sub", ["s2"]],
      ["base", ["b2"]],
    ]);
    await vi.waitFor(() => expect(subModule.make()).toBe("b2"));
    root.dispose();
  });

  it("re-binds a subclass of a base superseded before the batch applies", async () => {
    const { root, subModule } = await retriedBatch([
      ["base", ["b2"]],
      ["sub", ["s2"]],
      ["base", ["b3"]],
    ]);
    await vi.waitFor(() => expect(subModule.make()).toBe("b3"));
    root.dispose();
  });

  it("re-binds importers of a barrel in an import cycle", async () => {
    fixture.write("cyc-base.ts", ["export class Base { value() { return 1; } }"]);
    fixture.write("cyc-index.ts", ['export * from "./cyc-base.ts";', 'export * from "./cyc-sub.ts";']);
    fixture.write("cyc-sub.ts", [
      `import { Base } from "./cyc-index.ts";`,
      "export class Sub extends Base {}",
    ]);
    fixture.write("cyc-user.ts", [
      `import { Sub } from "./cyc-index.ts";`,
      "export function make() { return new Sub().value(); }",
    ]);
    const user = await fixture.load("cyc-user.ts");
    expect(user.make()).toBe(1);
    await fixture.update("cyc-base.ts", ["export class Base { value() { return 2; } }"]);
    await vi.waitFor(() => expect(user.make()).toBe(2));
  });
});

describe("DiHmrPlugin class environment", () => {
  it("replaces classes when an identity-only import changes source", async () => {
    fixture.write("dep-x.ts", ['export class Dep { name() { return "x"; } }']);
    fixture.write("dep-y.ts", ['export class Dep { name() { return "y"; } }']);
    const consumer = (source: string) => [
      ...imports,
      `import { Dep } from "./${source}";`,
      "export class Consumer { dep = inject(Dep); name() { return this.dep.name(); } }",
    ];
    fixture.write("consumer.ts", consumer("dep-x.ts"));
    const [x, y, mod] = await Promise.all(
      ["dep-x.ts", "dep-y.ts", "consumer.ts"].map((name) => fixture.load(name)),
    );
    const root = fixture.di.createRootScope();
    root.provideAll([x.Dep, y.Dep, mod.Consumer]);
    expect(root.get(mod.Consumer).name()).toBe("x");
    await fixture.update("consumer.ts", consumer("dep-y.ts"));
    await vi.waitFor(() => expect(root.get(mod.Consumer).name()).toBe("y"));
    root.dispose();
  });
});

describe("DiHmrPlugin export aliases", () => {
  it("re-binds importers when an alias points to another function", async () => {
    fixture.write("aliased.ts", [
      'function a() { return "a"; }',
      'function b() { return "b"; }',
      "export { a as pick };",
    ]);
    fixture.write("alias-user.ts", [
      `import { pick } from "./aliased.ts";`,
      "export function call() { return pick(); }",
    ]);
    const user = await fixture.load("alias-user.ts");
    expect(user.call()).toBe("a");
    await fixture.update("aliased.ts", [
      'function a() { return "a"; }',
      'function b() { return "b"; }',
      "export { b as pick };",
    ]);
    await vi.waitFor(() => expect(user.call()).toBe("b"));
  });
});

describe("DiHmrPlugin top-level code", () => {
  it("sees forwarders wherever module code captures exported functions", async () => {
    const module = (label: string) => [
      `export function describe() { return "${label}"; }`,
      "const registered = new Set([describe]);",
      "export function isRegistered(fn) { return registered.has(fn); }",
      "export class Holder { static describe = describe; }",
    ];
    fixture.write("capture.ts", module("v1"));
    const mod = await fixture.load("capture.ts");
    expect(mod.isRegistered(mod.describe)).toBe(true);

    await fixture.update("capture.ts", module("v2"));
    await vi.waitFor(() => expect(mod.describe()).toBe("v2"));
    expect(mod.Holder.describe()).toBe("v2");
    expect(mod.isRegistered(mod.describe)).toBe(true);
  });

  it("creates top-level instances from the re-evaluated class", async () => {
    const module = (label: string) => [
      "export class Item {}",
      "const item = new Item();",
      `export function check() { return "${label}:" + (item instanceof Item); }`,
    ];
    fixture.write("instance.ts", module("v1"));
    const mod = await fixture.load("instance.ts");
    await fixture.update("instance.ts", module("v2"));
    await vi.waitFor(() => expect(mod.check()).toBe("v2:true"));
  });

  it("lets a subclass evaluated while a base update waits extend the new base", async () => {
    const tool = (label: string) => [
      `export function useTool() { if (globalThis.__breakTool) throw new Error("broken ${label}"); }`,
    ];
    const base = (label: string) => [
      "export class Base { value() { return 1; } }",
      `export function describe() { return "${label}"; }`,
    ];
    const sub = (label: string) => [
      `import { Base } from "./base.ts";`,
      `export class Sub extends Base { label() { return "${label}"; } }`,
    ];
    fixture.write("tool.ts", tool("v1"));
    fixture.write("base.ts", base("v1"));
    fixture.write("sub.ts", sub("v1"));
    const [toolModule, baseModule, subModule] = await Promise.all(
      ["tool.ts", "base.ts", "sub.ts"].map((name) => fixture.load(name)),
    );
    const root = fixture.di.createRootScope();
    root.provide(baseModule.Base, subModule.Sub);
    root.setup(() => toolModule.useTool());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flags = globalThis as Record<string, unknown>;

    flags["__breakTool"] = true;
    await fixture.update("tool.ts", tool("v2"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    await fixture.update("base.ts", base("v2"));
    await fixture.update("sub.ts", sub("v2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    flags["__breakTool"] = false;
    await fixture.update("tool.ts", tool("v3"));
    await vi.waitFor(() => expect(root.get(baseModule.Base).label()).toBe("v2"));
    expect(root.get(baseModule.Base)).toBeInstanceOf((await fixture.load("base.ts")).Base);
    errors.mockRestore();
    root.dispose();
  });
});

describe("DiHmrPlugin import cycles", () => {
  it("evaluates natively when sensitive imports are uninitialized as a module finishes", async () => {
    const sources: Record<string, string> = {
      "cycle-index.mjs": `export * from "./cycle-window.mjs";\nexport * from "./cycle-doc.mjs";`,
      "cycle-doc.mjs": "export class Doc {}",
      "cycle-window.mjs": [
        `import { Doc } from "./cycle-index.mjs";`,
        "export function describe(value) { return value instanceof Doc; }",
      ].join("\n"),
    };
    for (const [name, code] of Object.entries(sources)) {
      const out = await transformHotModule(code, fixture.file(name), { forwardFunctions: false });
      writeFileSync(fixture.file(name), out?.code ?? code, "utf8");
    }
    fixture.write("cycle-main.mjs", [
      `import { Doc, describe } from "./cycle-index.mjs";`,
      "console.log(describe(new Doc()));",
    ]);
    const result = spawnSync(process.execPath, [fixture.file("cycle-main.mjs")], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("true");
  });
});

describe("DiHmrPlugin variant classes", () => {
  function messagesModule(version: string, variants = variantsPath): string[] {
    return [
      ...imports,
      `import { ExtensibleFields, ExtensibleVariants, variant } from ${JSON.stringify(variants)};`,
      `import { Registry } from "./registry.ts";`,
      counted("messages"),
      "abstract class Base extends ExtensibleVariants {}",
      "export abstract class Message extends Base {}",
      '@variant("test:hmr:note")',
      "export class Note extends Message {",
      `  label() { return "${version}:" + this.text; }`,
      "}",
      "export class Meta extends ExtensibleFields {}",
      'export const noteField = Meta.defineField("test:hmr:note-field");',
      "export function isBase(value) { return value instanceof Base; }",
      'export function useNotes() { inject(Registry).add(Note.create({ text: "a" }).label()); }',
    ];
  }

  it("hot updates modules that register variants and fields", async () => {
    writeRegistry();
    fixture.write("messages.ts", messagesModule("v1"));
    fixture.write("entry.ts", [
      `import { useNotes } from "./messages.ts";`,
      counted("entry"),
      "export function run() { useNotes(); }",
    ]);
    const { Registry } = await fixture.load("registry.ts");
    const entry = await fixture.load("entry.ts");
    const first = await fixture.load("messages.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.setup(() => entry.run());
    const registry = root.get(Registry) as { items: string[] };
    const old = first.Note.create({ text: "x" });
    const errors = vi.spyOn(console, "error");

    await fixture.update("messages.ts", messagesModule("v2"));
    await vi.waitFor(() => expect([...registry.items]).toEqual(["v2:a"]));
    expect(errors).not.toHaveBeenCalled();

    const next = await fixture.load("messages.ts");
    expect(next.Note).not.toBe(first.Note);
    expect(old).toBeInstanceOf(next.Note);
    expect(old).toBeInstanceOf(next.Message);
    expect(next.isBase(old)).toBe(true);
    expect(first.Note.create({ text: "y" }).label()).toBe("v2:y");
    expect(next.noteField).toBe(first.noteField);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals["entry"]).toBe(1);
    root.dispose();
  });
  it("leaves variant registrations untouched when an update fails to evaluate", async () => {
    const message = (version: string, fail = false) => [
      `import { ExtensibleVariants, variant, deserializeValue, serializeValue } from ${JSON.stringify(variantsPath)};`,
      counted("failing"),
      '@variant("test:hmr:failing")',
      "export class Message extends ExtensibleVariants {",
      `  label() { return "${version}"; }`,
      "}",
      `export function moduleVersion() { return "${version}"; }`,
      "export { deserializeValue, serializeValue };",
      ...(fail ? ['throw new Error("top-level update failed");'] : []),
    ];
    fixture.write("failing.ts", message("v1"));
    const first = await fixture.load("failing.ts");
    const instance = first.Message.create({});
    const serialized = JSON.parse(JSON.stringify(first.serializeValue(instance)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("failing.ts", message("v2", true));
    await vi.waitFor(() => expect(fixture.evals["failing"]).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.moduleVersion()).toBe("v1");
    expect(first.Message.create({}).label()).toBe("v1");
    expect(first.deserializeValue(serialized).label()).toBe("v1");
    expect(instance.label()).toBe("v1");

    await fixture.update("failing.ts", message("v2"));
    await vi.waitFor(() => expect(first.moduleVersion()).toBe("v2"));
    expect(first.Message.create({}).label()).toBe("v2");
    expect(first.deserializeValue(serialized).label()).toBe("v2");
    errors.mockRestore();
  });

  it("restores variant registrations when the update batch is rejected", async () => {
    const message = (version: string) => [
      ...imports,
      `import { ExtensibleVariants, variant, deserializeValue, serializeValue } from ${JSON.stringify(variantsPath)};`,
      '@variant("test:hmr:rejected")',
      "class Note extends ExtensibleVariants {",
      `  label() { return "${version}"; }`,
      "}",
      `export function useNote() { if ("${version}" === "bad") throw new Error("setup failed"); }`,
      "export function createNote() { return Note.create({}); }",
      "export { deserializeValue, serializeValue };",
    ];
    fixture.write("rejected.ts", message("v1"));
    const first = await fixture.load("rejected.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => first.useNote());
    const serialized = JSON.parse(JSON.stringify(first.serializeValue(first.createNote())));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("rejected.ts", message("bad"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(first.createNote().label()).toBe("v1");
    expect(first.deserializeValue(serialized).label()).toBe("v1");
    errors.mockRestore();
    root.dispose();
  });

  it("re-registers variants through their importers when the variants module itself changes", async () => {
    cpSync(variantsSrc, fixture.file("lib/variants"), { recursive: true });
    const variants = fixture.file("lib/variants/index.ts");
    writeRegistry();
    fixture.write("messages.ts", messagesModule("v1", variants));
    const first = await fixture.load("messages.ts");
    const lib = await fixture.runner.import(variants);
    const old = first.Note.create({ text: "x" });
    const serialized = JSON.parse(JSON.stringify(lib.serializeValue(old)));
    const errors = vi.spyOn(console, "error");

    const source = readFileSync(fixture.file("lib/variants/variants.ts"), "utf8");
    await fixture.update("lib/variants/variants.ts", [source, "export const edited = true;"]);
    await vi.waitFor(() => expect(fixture.evals["messages"]).toBe(2));
    expect(errors).not.toHaveBeenCalled();

    const next = await fixture.load("messages.ts");
    const nextLib = await fixture.runner.import(variants);
    expect(nextLib).not.toBe(lib);
    const revived = nextLib.deserializeValue(serialized);
    expect(revived).toBeInstanceOf(next.Note);
    expect(revived.label()).toBe("v1:x");
    expect(old).toBeInstanceOf(next.Note);
    expect(next.Note.create({ text: "y" }).label()).toBe("v1:y");
  });

  it("rejects a variant or field name registered twice by one module evaluation", async () => {
    fixture.write("duplicate-variant.ts", [
      `import { ExtensibleVariants, variant } from ${JSON.stringify(variantsPath)};`,
      '@variant("test:hmr:duplicate")',
      "export class A extends ExtensibleVariants {}",
      '@variant("test:hmr:duplicate")',
      "export class B extends ExtensibleVariants {}",
    ]);
    fixture.write("duplicate-field.ts", [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      "export class Meta extends ExtensibleFields {}",
      'export const a = Meta.defineField("test:hmr:duplicate-field");',
      'export const b = Meta.defineField("test:hmr:duplicate-field");',
    ]);
    await expect(fixture.load("duplicate-variant.ts")).rejects.toThrow(
      'Duplicate variant name: "test:hmr:duplicate"',
    );
    await expect(fixture.load("duplicate-field.ts")).rejects.toThrow(
      'Duplicate field name: "test:hmr:duplicate-field"',
    );
  });

  it("drops a field defined by an update that fails to evaluate", { timeout: 30_000 }, async () => {
    fixture.write("meta.ts", [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      "export class Meta extends ExtensibleFields {}",
    ]);
    const owner = (fail: boolean) => [
      `import { Meta } from "./meta.ts";`,
      counted("field-owner"),
      ...(fail
        ? ['export const late = Meta.defineField("test:hmr:late");', 'throw new Error("update failed");']
        : ["export const late = undefined;"]),
    ];
    fixture.write("field-owner.ts", owner(false));
    await fixture.load("field-owner.ts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("field-owner.ts", owner(true));
    await vi.waitFor(() => expect(fixture.evals["field-owner"]).toBe(2), { timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    fixture.write("field-user.ts", [
      `import { Meta } from "./meta.ts";`,
      'export const late = Meta.defineField("test:hmr:late");',
    ]);
    expect((await fixture.load("field-user.ts")).late.name).toBe("test:hmr:late");
    errors.mockRestore();
  });

  it("drops a field defined by an update whose batch is rejected", { timeout: 30_000 }, async () => {
    fixture.write("meta.ts", [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      "export class Meta extends ExtensibleFields {}",
    ]);
    const owner = (version: string) => [
      ...imports,
      `import { Meta } from "./meta.ts";`,
      ...(version === "bad" ? ['Meta.defineField("test:hmr:rejected");'] : []),
      `export function useOwner() { if ("${version}" === "bad") throw new Error("setup failed"); }`,
    ];
    fixture.write("rejected-owner.ts", owner("v1"));
    const first = await fixture.load("rejected-owner.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => first.useOwner());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("rejected-owner.ts", owner("bad"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 15_000 });
    fixture.write("field-user.ts", [
      `import { Meta } from "./meta.ts";`,
      'export const late = Meta.defineField("test:hmr:rejected");',
    ]);
    expect((await fixture.load("field-user.ts")).late.name).toBe("test:hmr:rejected");
    errors.mockRestore();
    root.dispose();
  });

  it("serializes instances created before the variants module itself changed", async () => {
    cpSync(variantsSrc, fixture.file("lib/variants"), { recursive: true });
    const variants = fixture.file("lib/variants/index.ts");
    writeRegistry();
    fixture.write("messages.ts", messagesModule("v1", variants));
    const first = await fixture.load("messages.ts");
    const lib = await fixture.runner.import(variants);
    const old = first.Note.create({ text: "x" });

    const source = readFileSync(fixture.file("lib/variants/variants.ts"), "utf8");
    const header = "export abstract class ExtensibleVariants<TDefaults extends object = {}> {";
    expect(source).toContain(header);
    await fixture.update("lib/variants/variants.ts", [
      source.replace(header, `${header}\n  edited() { return true; }`),
    ]);
    await vi.waitFor(() => expect(fixture.evals["messages"]).toBe(2));

    const next = await fixture.load("messages.ts");
    const nextLib = await fixture.runner.import(variants);
    expect(nextLib).not.toBe(lib);
    const serialized = JSON.parse(JSON.stringify(nextLib.serializeValue(old)));
    expect(serialized).toEqual({ $variants: ["test:hmr:note"], text: "x" });
    const revived = nextLib.deserializeValue(serialized);
    expect(revived).toBeInstanceOf(next.Note);
    expect(revived.label()).toBe("v1:x");
    expect(revived.edited()).toBe(true);
    expect(old).toBeInstanceOf(nextLib.ExtensibleVariants);
    expect(revived).toBeInstanceOf(lib.ExtensibleVariants);
    expect(old).toBeInstanceOf(next.Note);
    expect(lib.serializeValue(revived)).toEqual(serialized);
  });

  it("keeps field values of instances created before the fields module itself changed", async () => {
    cpSync(variantsSrc, fixture.file("lib/variants"), { recursive: true });
    const variants = fixture.file("lib/variants/index.ts");
    writeRegistry();
    fixture.write("messages.ts", messagesModule("v1", variants));
    const first = await fixture.load("messages.ts");
    const lib = await fixture.runner.import(variants);
    const meta = new first.Meta().set(first.noteField, 9);
    const note = first.Note.create({ text: "x", meta });

    const source = readFileSync(fixture.file("lib/variants/fields.ts"), "utf8");
    const header = "export abstract class ExtensibleFields {";
    expect(source).toContain(header);
    await fixture.update("lib/variants/fields.ts", [
      source.replace(header, `${header}\n  edited() { return true; }`),
    ]);
    await vi.waitFor(() => expect(fixture.evals["messages"]).toBe(2));

    const next = await fixture.load("messages.ts");
    const nextLib = await fixture.runner.import(variants);
    expect(nextLib).not.toBe(lib);
    expect(JSON.stringify(nextLib.serializeValue(meta))).toBe('{"test:hmr:note-field":9}');
    const serialized = JSON.parse(JSON.stringify(nextLib.serializeValue(note)));
    expect(serialized).toEqual({
      $variants: ["test:hmr:note"],
      text: "x",
      meta: { "test:hmr:note-field": 9 },
    });
    expect(meta).toBeInstanceOf(nextLib.ExtensibleFields);
    expect(next.noteField).toBe(first.noteField);
    expect(meta.get(next.noteField)).toBe(9);
    const revived = next.Meta.deserialize(nextLib.serializeValue(meta));
    expect(revived.edited()).toBe(true);
    expect(revived.get(first.noteField)).toBe(9);
    expect(new next.Meta(meta).get(next.noteField)).toBe(9);
  });

  it("keeps the key of a field defined in a static initializer when its class changes", async () => {
    const meta = (version: string) => [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      counted("static-meta"),
      "export class Meta extends ExtensibleFields {",
      '  static key = this.defineField("test:hmr:static");',
      `  label() { return "${version}"; }`,
      "}",
    ];
    fixture.write("static-meta.ts", meta("v1"));
    const first = await fixture.load("static-meta.ts");
    const old = new first.Meta().set(first.Meta.key, 1);
    const errors = vi.spyOn(console, "error");

    await fixture.update("static-meta.ts", meta("v2"));
    await vi.waitFor(() => expect(fixture.evals["static-meta"]).toBe(2), 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).not.toHaveBeenCalled();
    const next = await fixture.load("static-meta.ts");
    expect(next.Meta).not.toBe(first.Meta);
    expect(next.Meta.key).toBe(first.Meta.key);
    expect(old.get(next.Meta.key)).toBe(1);
  });

  it("lets module code read the variants its own evaluation registers", async () => {
    // Not instrumented: updating it re-evaluates both importers in one update.
    fixture.write("lib/variants/startup-version.ts", ['export const VERSION = "v1";']);
    fixture.write("startup.ts", [
      `import { ExtensibleVariants, variant, deserializeValue } from ${JSON.stringify(variantsPath)};`,
      `import { VERSION } from "./lib/variants/startup-version.ts";`,
      '@variant("test:hmr:startup")',
      "export class Startup extends ExtensibleVariants {",
      "  label() { return VERSION; }",
      "}",
      'export const revived = deserializeValue({ $variants: ["test:hmr:startup"] });',
      "export { deserializeValue };",
    ]);
    fixture.write("startup-reader.ts", [
      `import { deserializeValue } from ${JSON.stringify(variantsPath)};`,
      `import "./startup.ts";`,
      `import "./lib/variants/startup-version.ts";`,
      counted("startup-reader"),
      'export const revived = deserializeValue({ $variants: ["test:hmr:startup"] });',
      "(globalThis.__startupLabels ??= []).push(revived.label());",
    ]);
    const first = await fixture.load("startup.ts");
    expect(first.revived.label()).toBe("v1");
    expect((await fixture.load("startup-reader.ts")).revived.label()).toBe("v1");
    const errors = vi.spyOn(console, "error");

    await fixture.update("lib/variants/startup-version.ts", ['export const VERSION = "v2";']);
    await vi.waitFor(() => expect(fixture.evals["startup-reader"]).toBeGreaterThan(1), 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).not.toHaveBeenCalled();
    const next = await fixture.load("startup.ts");
    expect(next.Startup).not.toBe(first.Startup);
    expect(Object.getPrototypeOf(next.revived)).toBe(next.Startup.prototype);
    const reader = await fixture.load("startup-reader.ts");
    expect(Object.getPrototypeOf(reader.revived)).toBe(next.Startup.prototype);
    const labels = (globalThis as Record<string, unknown>)["__startupLabels"] as string[];
    expect(labels[0]).toBe("v1");
    expect(labels.slice(1)).toEqual(labels.slice(1).map(() => "v2"));
    expect(first.deserializeValue({ $variants: ["test:hmr:startup"] }).label()).toBe("v2");
  });

  it("rejects a variant or field name first declared by two modules of one update", async () => {
    // Not instrumented: updating it re-evaluates every claimant in one update.
    const flag = (claim: boolean) => [
      `export const CLAIM = ${claim};`,
      "export function record(claim) {",
      "  try { return claim(); } catch (error) { globalThis.__claimErrors.push(error.message); throw error; }",
      "}",
    ];
    const claimErrors: string[] = [];
    (globalThis as Record<string, unknown>)["__claimErrors"] = claimErrors;
    fixture.write("lib/variants/claim-flag.ts", flag(false));
    fixture.write("claim-meta.ts", [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      "export class Meta extends ExtensibleFields {}",
    ]);
    const claimant = (local: string) => [
      `import { ExtensibleVariants, variant } from ${JSON.stringify(variantsPath)};`,
      `import { CLAIM, record } from "./lib/variants/claim-flag.ts";`,
      `export class ${local} extends ExtensibleVariants {}`,
      `if (CLAIM) record(() => variant("test:hmr:claimed")(${local}));`,
    ];
    const fieldClaimant = [
      `import { CLAIM, record } from "./lib/variants/claim-flag.ts";`,
      `import { Meta } from "./claim-meta.ts";`,
      'if (CLAIM) record(() => Meta.defineField("test:hmr:claimed-field"));',
      "export const owner = Meta;",
    ];
    fixture.write("claim-a.ts", claimant("A"));
    fixture.write("claim-b.ts", claimant("B"));
    fixture.write("claim-field-a.ts", fieldClaimant);
    fixture.write("claim-field-b.ts", fieldClaimant);
    for (const name of ["claim-a.ts", "claim-b.ts", "claim-field-a.ts", "claim-field-b.ts"]) {
      await fixture.load(name);
    }
    const lib = await fixture.runner.import(variantsPath);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("lib/variants/claim-flag.ts", flag(true));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await fixture.runner.import(variantsPath)).toBe(lib);
    expect(claimErrors.sort()).toEqual([
      'Duplicate field name: "test:hmr:claimed-field"',
      'Duplicate variant name: "test:hmr:claimed"',
    ]);
    expect(() => lib.deserializeValue({ $variants: ["test:hmr:claimed"] })).toThrow(
      "Unknown variant chain",
    );
    errors.mockRestore();
  });

  it("releases variant and field names a module no longer declares", async () => {
    fixture.write("moved-meta.ts", [
      `import { ExtensibleFields } from ${JSON.stringify(variantsPath)};`,
      "export class Meta extends ExtensibleFields {}",
    ]);
    // Same exports in every version: a changed export list would reload the whole module graph.
    const declare = (local: string, declared = true) => [
      `import { ExtensibleVariants, variant } from ${JSON.stringify(variantsPath)};`,
      `import { Meta } from "./moved-meta.ts";`,
      counted(local),
      ...(declared ? ['@variant("test:hmr:moved")'] : []),
      `export class ${local} extends ExtensibleVariants {}`,
      `export function defineMoved() { return Meta.defineField("test:hmr:moved-field"); }`,
      ...(declared ? ["defineMoved();"] : []),
    ];
    fixture.write("moved-from.ts", declare("Old"));
    await fixture.load("moved-from.ts");
    const lib = await fixture.runner.import(variantsPath);
    const errors = vi.spyOn(console, "error");

    await fixture.update("moved-from.ts", declare("Old", false));
    await vi.waitFor(() => expect(fixture.evals["Old"]).toBe(2), 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).not.toHaveBeenCalled();
    expect(await fixture.runner.import(variantsPath)).toBe(lib);
    fixture.write("moved-to.ts", declare("New"));
    const moved = await fixture.load("moved-to.ts");
    expect(lib.deserializeValue({ $variants: ["test:hmr:moved"] })).toBeInstanceOf(moved.New);
  });

  it("hides variants staged by a pending or failed update from code outside its evaluation", async () => {
    const owner = (version: "v1" | "pending" | "failed") => [
      ...imports,
      `import { ExtensibleVariants, variant, deserializeValue } from ${JSON.stringify(variantsPath)};`,
      counted("staged-owner"),
      ...(version === "v1"
        ? []
        : [
            '@variant("test:hmr:staged")',
            "class Staged extends ExtensibleVariants {}",
            'deserializeValue({ $variants: ["test:hmr:staged"] });',
          ]),
      ...(version === "failed" ? ['throw new Error("update failed");'] : []),
      `export function useOwner() { if ("${version}" !== "v1") throw new Error("setup failed"); }`,
      "export { deserializeValue };",
    ];
    fixture.write("staged-owner.ts", owner("v1"));
    const first = await fixture.load("staged-owner.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => first.useOwner());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const revive = () => first.deserializeValue({ $variants: ["test:hmr:staged"] });

    await fixture.update("staged-owner.ts", owner("pending"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), 5000);
    expect(fixture.evals["staged-owner"]).toBe(2);
    expect(revive).toThrow("Unknown variant chain");

    await fixture.update("staged-owner.ts", owner("failed"));
    await vi.waitFor(() => expect(fixture.evals["staged-owner"]).toBe(3), 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(revive).toThrow("Unknown variant chain");
    fixture.write("staged-reader.ts", [
      `import { deserializeValue } from ${JSON.stringify(variantsPath)};`,
      'export const revived = deserializeValue({ $variants: ["test:hmr:staged"] });',
    ]);
    await expect(fixture.load("staged-reader.ts")).rejects.toThrow("Unknown variant chain");
    errors.mockRestore();
    root.dispose();
  });
});

describe("DiHmrPlugin hot runtime updates", () => {
  it("performs a full reload and gives the new module graph working forwarders", async () => {
    fixture.write("packages/di/src/stateful.ts", [
      counted("stateful"),
      "export const state = { generation: globalThis.__hmrEvals.stateful };",
      "import.meta.hot?.on('vite:beforeFullReload', () => { globalThis.__hmrEvals.disposed = (globalThis.__hmrEvals.disposed ?? 0) + 1; });",
    ]);
    writeRegistry();
    fixture.write("tools.ts", [...toolModule("v1"), `import "./packages/di/src/stateful.ts";`]);
    await fixture.load("tools.ts");

    await fixture.update("packages/di/src/stateful.ts", [
      counted("stateful"),
      "export const state = { generation: globalThis.__hmrEvals.stateful };",
      "import.meta.hot?.on('vite:beforeFullReload', () => { globalThis.__hmrEvals.disposed = (globalThis.__hmrEvals.disposed ?? 0) + 1; });",
      "export const touched = true;",
    ]);
    await vi.waitFor(() => expect(fixture.evals["disposed"]).toBe(1));
    await vi.waitFor(() => expect(fixture.evals["tools"]).toBe(2));

    const di = (await fixture.runner.import(diPath)) as Di;
    expect(di).not.toBe(fixture.di);
    const { Registry } = await fixture.load("registry.ts");
    const tools = await fixture.load("tools.ts");
    const root = di.createRootScope();
    root.provide(Registry);
    root.setup(() => tools.useTool());
    const registry = root.get(Registry) as { items: string[] };
    expect([...registry.items]).toEqual(["tool:v1"]);

    await fixture.update("tools.ts", [...toolModule("v2"), `import "./packages/di/src/stateful.ts";`]);
    await vi.waitFor(() => expect([...registry.items]).toEqual(["tool:v2"]));
    root.dispose();
  });
});

describe("DiHmrPlugin function properties", () => {
  it("keeps properties assigned to exported functions", async () => {
    fixture.write("described.ts", [
      "export function useDescribed() { return 1; }",
      'useDescribed.label = "described";',
      "export const arrow = () => 2;",
      'Object.assign(arrow, { label: "arrow" });',
    ]);
    const mod = await fixture.load("described.ts");
    expect(mod.useDescribed.label).toBe("described");
    expect(mod.arrow.label).toBe("arrow");
  });

  it("keeps properties assigned outside top-level statements and prototype methods", async () => {
    const module = (label: string) => [
      "export function f() { return 1; }",
      `if (true) f.label = "${label}";`,
      "export function Point(x) { this.x = x; }",
      `Point.prototype.getX = function () { return "${label}:" + this.x; };`,
    ];
    fixture.write("described-nested.ts", module("v1"));
    const mod = await fixture.load("described-nested.ts");
    expect(mod.f.label).toBe("v1");
    expect(new mod.Point(3).getX()).toBe("v1:3");
    await fixture.update("described-nested.ts", module("v2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await fixture.load("described-nested.ts");
    expect(new next.Point(3).getX()).toBe("v2:3");
    expect(next.f.label).toBe("v2");
  });

  it("leaves prototype methods untouched by an update that is rejected", async () => {
    const module = (label: string) => [
      "export function Point(x) { this.x = x; }",
      `Point.prototype.getX = function () { return "${label}:" + this.x; };`,
      `export function usePoint() { if (globalThis.__breakPoint) throw new Error("broken ${label}"); }`,
    ];
    fixture.write("point.ts", module("v1"));
    const mod = await fixture.load("point.ts");
    const root = fixture.di.createRootScope();
    root.setup(() => mod.usePoint());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as Record<string, unknown>)["__breakPoint"] = true;
    await fixture.update("point.ts", module("v2"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    (globalThis as Record<string, unknown>)["__breakPoint"] = false;
    expect(new mod.Point(1).getX()).toBe("v1:1");
    errors.mockRestore();
    root.dispose();
  });

  it("keeps the kind of async and generator functions it forwards", async () => {
    const module = (label: string) => [
      `export async function load() { return "${label}"; }`,
      `export function* items() { yield "${label}"; }`,
    ];
    fixture.write("kinds.ts", module("v1"));
    const mod = await fixture.load("kinds.ts");
    expect(mod.load.constructor.name).toBe("AsyncFunction");
    expect(mod.items.constructor.name).toBe("GeneratorFunction");
    await fixture.update("kinds.ts", module("v2"));
    await vi.waitFor(async () => expect(await mod.load()).toBe("v2"));
    expect([...mod.items()]).toEqual(["v2"]);
  });
});

describe("DiHmrPlugin stack review", () => {
  it("leaves no variant registration behind when a first evaluation throws", { timeout: 30_000 }, async () => {
    const declare = (file: string, fail: boolean) =>
      fixture.write(file, [
        `import { ExtensibleVariants, variant } from ${JSON.stringify(variantsPath)};`,
        '@variant("test:hmr:first-throw")',
        "export class Claimed extends ExtensibleVariants {}",
        ...(fail ? ['throw new Error("first evaluation failed");'] : []),
      ]);
    declare("first-throw-a.ts", true);
    declare("first-throw-b.ts", false);
    await expect(fixture.load("first-throw-a.ts")).rejects.toThrow("first evaluation failed");
    await expect(fixture.load("first-throw-b.ts")).resolves.toBeDefined();
  });

  it("withholds a batch while one of its modules fails to evaluate", async () => {
    fixture.write("lib/variants/shared.ts", ["export const N = 1;"]);
    fixture.write("withheld-a.ts", [
      `import { N } from "./lib/variants/shared.ts";`,
      "export function value() { return N; }",
    ]);
    const b = (fail: boolean) => [
      `import { N } from "./lib/variants/shared.ts";`,
      ...(fail ? ['if (N === 2) throw new Error("b failed");'] : []),
      "export function other() { return N; }",
    ];
    fixture.write("withheld-b.ts", b(true));
    const a = await fixture.load("withheld-a.ts");
    await fixture.load("withheld-b.ts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("lib/variants/shared.ts", ["export const N = 2;"]);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(a.value()).toBe(1);

    await fixture.update("withheld-b.ts", b(false));
    await vi.waitFor(() => expect(a.value()).toBe(2));
    errors.mockRestore();
  });

  it("keeps withholding a batch across updates of unrelated modules", async () => {
    fixture.write("lib/variants/held-shared.ts", ["export const N = 1;"]);
    fixture.write("held-a.ts", [
      `import { N } from "./lib/variants/held-shared.ts";`,
      "export function value() { return N; }",
    ]);
    const b = (fail: boolean) => [
      `import { N } from "./lib/variants/held-shared.ts";`,
      ...(fail ? ['if (N === 2) throw new Error("b failed");'] : []),
      "export function other() { return N; }",
    ];
    fixture.write("held-b.ts", b(true));
    fixture.write("held-c.ts", ['export function c() { return "c1"; }']);
    const [a, , c] = await Promise.all(["held-a.ts", "held-b.ts", "held-c.ts"].map((name) => fixture.load(name)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("lib/variants/held-shared.ts", ["export const N = 2;"]);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    // Updates stay pending together until the failed module evaluates, so nothing applies halfway.
    await fixture.update("held-c.ts", ['export function c() { return "c2"; }']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([a.value(), c.c()]).toEqual([1, "c1"]);

    await fixture.update("held-b.ts", b(false));
    await vi.waitFor(() => expect([a.value(), c.c()]).toEqual([2, "c2"]));
    errors.mockRestore();
  });

  it("lets top-level code of an updated module call its new functions", async () => {
    const module = (value: number) => [
      `export function getLimit() { return ${value}; }`,
      "export const limit = getLimit();",
    ];
    fixture.write("limit.ts", module(1));
    const first = await fixture.load("limit.ts");
    expect(first.limit).toBe(1);
    await fixture.update("limit.ts", module(2));
    await vi.waitFor(async () => expect((await fixture.load("limit.ts")).limit).toBe(2));
    expect(first.getLimit()).toBe(2);
  });

  it("re-runs importers outside the instrumentation that hold a replaced class", async () => {
    const base = (value: number) => [`export class Base { value() { return ${value}; } }`];
    fixture.write("plain-base.ts", base(1));
    fixture.write("plain/user.ts", [
      `import { Base } from "../plain-base.ts";`,
      "class Sub extends Base {}",
      "globalThis.__plainMake = () => new Sub().value();",
    ]);
    await fixture.load("plain/user.ts");
    const make = () => (globalThis as Record<string, () => number>)["__plainMake"]!();
    expect(make()).toBe(1);
    await fixture.update("plain-base.ts", base(2));
    await vi.waitFor(() => expect(make()).toBe(2));
  });

  it("does not re-run importers outside the instrumentation that only hand a class to DI", async () => {
    const service = (value: number) => [`export class PlainService { value() { return ${value}; } }`];
    fixture.write("plain-service.ts", service(1));
    fixture.write("plain/root.ts", [
      `import { createRootScope } from ${JSON.stringify(diPath)};`,
      `import { PlainService } from "../plain-service.ts";`,
      counted("plainRoot"),
      "export const root = createRootScope();",
      "root.provideAll([PlainService]);",
      "export function value() { return root.get(PlainService).value(); }",
    ]);
    const mod = await fixture.load("plain/root.ts");
    expect(mod.value()).toBe(1);
    await fixture.update("plain-service.ts", service(2));
    await vi.waitFor(() => expect(mod.value()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals["plainRoot"]).toBe(1);
    mod.root.dispose();
  });

  it("replaces a class whose local name changes while its export name stays", async () => {
    fixture.write("renamed.ts", ["export class Service { value() { return 1; } }"]);
    const first = await fixture.load("renamed.ts");
    const root = fixture.di.createRootScope();
    root.provide(first.Service);
    await fixture.update("renamed.ts", [
      "class Impl { value() { return 2; } }",
      "export { Impl as Service };",
    ]);
    await vi.waitFor(async () => {
      const next = await fixture.load("renamed.ts");
      expect(root.get(next.Service).value()).toBe(2);
    });
    root.dispose();
  });

  it("carries a changed default export through a re-export", async () => {
    fixture.write("default-src.ts", ["export default 1;"]);
    fixture.write("default-barrel.ts", ['export { default as limit } from "./default-src.ts";']);
    fixture.write("default-user.ts", [
      `import { limit } from "./default-barrel.ts";`,
      "export function read() { return limit; }",
    ]);
    const user = await fixture.load("default-user.ts");
    expect(user.read()).toBe(1);
    await fixture.update("default-src.ts", ["export default 2;"]);
    await vi.waitFor(() => expect(user.read()).toBe(2));
  });

  it("keeps the identity of equal plain data an updated module recreates", async () => {
    const module = (label: string) => [
      "export const token = Object.freeze({});",
      `export function isToken(value) { return value === token && "${label}" !== ""; }`,
    ];
    fixture.write("token.ts", module("v1"));
    fixture.write("token-user.ts", [
      `import { token, isToken } from "./token.ts";`,
      "export function check() { return isToken(token); }",
    ]);
    const user = await fixture.load("token-user.ts");
    expect(user.check()).toBe(true);
    await fixture.update("token.ts", module("v2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(user.check()).toBe(true);
  });
});

describe("DiHmrPlugin setup units", () => {
  const unit = (name: string, label: string) => [
    `import { defineSetup, inject } from ${JSON.stringify(diPath)};`,
    `import { Registry } from "./registry.ts";`,
    counted(`module:${name}`),
    `export const use${name} = defineSetup((prefix) => {`,
    `  ${counted(`run:${name}`)}`,
    `  inject(Registry).add(\`\${prefix}:${name}:${label}\`);`,
    "});",
  ];
  const app = (prefix: string) => [
    `import { useA } from "./a.ts";`,
    `import { useB } from "./b.ts";`,
    counted("module:app"),
    `export function useApp() { ${counted("run:app")} useA("${prefix}"); useB("${prefix}"); }`,
  ];

  async function setupApp() {
    writeRegistry();
    fixture.write("a.ts", unit("A", "v1"));
    fixture.write("b.ts", unit("B", "v1"));
    fixture.write("app.ts", app("p"));
    const { Registry } = await fixture.load("registry.ts");
    const appModule = await fixture.load("app.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.setup(() => appModule.useApp());
    const items = () => [...(root.get(Registry) as { items: string[] }).items].sort();
    expect(items()).toEqual(["p:A:v1", "p:B:v1"]);
    return { root, items };
  }

  it("re-runs only the unit whose code changed, keeping the unit and its importers", async () => {
    const { root, items } = await setupApp();
    const { useA } = await fixture.load("a.ts");

    await fixture.update("a.ts", unit("A", "v2"));
    await vi.waitFor(() => expect(items()).toEqual(["p:A:v2", "p:B:v1"]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.evals).toMatchObject({ "module:app": 1, "run:app": 1, "run:A": 2, "run:B": 1 });
    expect((await fixture.load("a.ts")).useA).toBe(useA);
    root.dispose();
  });

  it("re-creates the units with the new arguments when the calling setup re-runs", async () => {
    const { root, items } = await setupApp();

    await fixture.update("app.ts", app("q"));
    await vi.waitFor(() => expect(items()).toEqual(["q:A:v1", "q:B:v1"]));
    expect(fixture.evals).toMatchObject({ "run:app": 2, "run:A": 2, "run:B": 2 });
    root.dispose();
  });

  it("re-runs a unit of a client module without forwarding its other functions", async () => {
    writeRegistry();
    fixture.write("unit.client.ts", unit("C", "v1"));
    const { Registry } = await fixture.load("registry.ts");
    const { useC } = await fixture.load("unit.client.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.setup(() => useC("p"));
    const items = () => [...(root.get(Registry) as { items: string[] }).items];

    await fixture.update("unit.client.ts", unit("C", "v2"));
    await vi.waitFor(() => expect(items()).toEqual(["p:C:v2"]));
    expect((await fixture.load("unit.client.ts")).useC).toBe(useC);
    root.dispose();
  });

  it("rejects a unit called outside a setup", async () => {
    writeRegistry();
    fixture.write("a.ts", unit("A", "v1"));
    const { useA } = await fixture.load("a.ts");
    expect(() => useA("p")).toThrow("useA() can only be called inside a setup");
  });
});

describe("DiHmrPlugin default exports", () => {
  for (const [kind, source, read] of [
    ["an expression", (v: number) => [`export default ${v};`], "mod.default"],
    ["an arrow", (v: number) => [`export default () => ${v};`], "mod.default()"],
    ["an anonymous function", (v: number) => [`export default function () { return ${v}; }`], "mod.default()"],
    ["an anonymous class", (v: number) => [`export default class { value() { return ${v}; } }`], "new mod.default().value()"],
  ] as const) {
    it(`hot updates a default export that is ${kind}`, async () => {
      const file = `default-${kind.replaceAll(" ", "-")}.ts`;
      fixture.write(file, source(1));
      fixture.write(`user-${file}`, [
        `import * as mod from "./${file}";`,
        `export function read() { return ${read}; }`,
        "export function name() { return typeof mod.default === 'function' ? mod.default.name : undefined; }",
      ]);
      const user = await fixture.load(`user-${file}`);
      expect(user.read()).toBe(1);
      if (kind !== "an expression") expect(user.name()).toBe("default");
      await fixture.update(file, source(2));
      await vi.waitFor(() => expect(user.read()).toBe(2));
    });
  }

  it("names anonymous default functions and classes natively without forwarding", async () => {
    const sources = {
      arrow: "export default () => 1;",
      fn: "export default function () { return 1; }",
      gen: "export default async function* () {}",
      cls: "export default class {}",
      expr: "export default (class {});",
      own: "export default (class { static name = 'own'; });",
    };
    const names: Record<string, string> = {};
    for (const [key, code] of Object.entries(sources)) {
      fixture.write(`anon-${key}.client.ts`, [code]);
      names[key] = (await fixture.load(`anon-${key}.client.ts`)).default.name;
    }
    expect(names).toEqual({ arrow: "default", fn: "default", gen: "default", cls: "default", expr: "default", own: "own" });
  });
});

describe("DiHmrPlugin round three", () => {
  it("replaces classes when a function the module calls at top level changes", async () => {
    const module = (value: number) => [
      `export function factor() { return ${value}; }`,
      "const n = factor();",
      "export class Reader { n() { return n; } }",
    ];
    fixture.write("eager.ts", module(1));
    await fixture.load("eager.ts");
    await fixture.update("eager.ts", module(2));
    await vi.waitFor(async () => expect(new (await fixture.load("eager.ts")).Reader().n()).toBe(2));
  });

  it("re-binds importers when a re-exported import switches its source", async () => {
    fixture.write("src-one.ts", ["export const value = 1;"]);
    fixture.write("src-two.ts", ["export const value = 2;"]);
    const barrel = (source: string) => [`import { value } from "./${source}";`, "export { value };"];
    fixture.write("switch-barrel.ts", barrel("src-one.ts"));
    fixture.write("switch-user.ts", [
      `import { value } from "./switch-barrel.ts";`,
      "export function read() { return value; }",
    ]);
    const user = await fixture.load("switch-user.ts");
    expect(user.read()).toBe(1);
    await fixture.update("switch-barrel.ts", barrel("src-two.ts"));
    await vi.waitFor(() => expect(user.read()).toBe(2));
  });

  it("re-runs uninstrumented importers that reach a replaced class through a namespace", async () => {
    const source = (value: number) => [`export class Versioned { static version = ${value}; }`];
    fixture.write("ns-class.ts", source(1));
    fixture.write("plain/ns-user.ts", [
      `import * as api from "../ns-class.ts";`,
      "globalThis.__nsVersion = () => api.Versioned.version;",
    ]);
    await fixture.load("plain/ns-user.ts");
    const version = () => (globalThis as Record<string, () => number>)["__nsVersion"]!();
    expect(version()).toBe(1);
    await fixture.update("ns-class.ts", source(2));
    await vi.waitFor(() => expect(version()).toBe(2));
  });
});

describe("DiHmrPlugin rejected batches", () => {
  it("keeps running service instances and their state when the batch is rejected", async () => {
    // One change to an uninstrumented shared module updates A and B in one batch.
    fixture.write("lib/variants/batch-shared.ts", ["export const N = 1;"]);
    fixture.write("batch-a.ts", [
      ...imports,
      `import { N } from "./lib/variants/batch-shared.ts";`,
      "export class A {",
      "  state = 0;",
      "  n() { return N; }",
      "  disposed = false;",
      "  constructor() { onScopeDispose(() => { this.disposed = true; }); }",
      "}",
    ]);
    fixture.write("batch-b.ts", [
      ...imports,
      `import { N } from "./lib/variants/batch-shared.ts";`,
      "export class B {",
      '  constructor() { if (N === 2) throw new Error("b failed"); }',
      "}",
    ]);
    const [modA, modB] = await Promise.all([fixture.load("batch-a.ts"), fixture.load("batch-b.ts")]);
    const root = fixture.di.createRootScope();
    root.provideAll([modA.A, modB.B]);
    const instance = root.get(modA.A);
    instance.state = 42;
    root.get(modB.B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await fixture.update("lib/variants/batch-shared.ts", ["export const N = 2;"]);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(String(errors.mock.calls[0]![0])).toContain("rejected");
    expect(root.get(modA.A)).toBe(instance);
    expect(instance.state).toBe(42);
    expect(instance.disposed).toBe(false);
    errors.mockRestore();
    root.dispose();
  });

});

describe("transformHotModule", () => {
  it("treats calls of a shadowed DI callee as sensitive uses", async () => {
    const code = [
      `import { inject } from ${JSON.stringify(diPath)};`,
      `import { Dep } from "./dep.ts";`,
      "export function make(inject) { return inject(Dep); }",
    ].join("\n");
    const result = (await transformHotModule(code, "/a.ts", { resolve: async () => "/dep.ts" }))!;
    expect(result.code).toContain('.deps({"/dep.ts":["Dep"]}, {})');
  });

  it("leaves modules with top-level await in class keys or indirect import.meta use to Vite", async () => {
    expect(
      await transformHotModule("export class A { [await Promise.resolve('k')]() {} }", "/a.ts"),
    ).toBe(undefined);
    expect(
      await transformHotModule("const meta = import.meta;\nexport function f() { return meta; }", "/a.ts"),
    ).toBe(undefined);
    expect(
      await transformHotModule("export function f() { return import.meta.url; }", "/a.ts"),
    ).toBeDefined();
  });

  it("instruments modules that only mention import.meta.hot outside code", async () => {
    const code = '// see import.meta.hot\nexport function f() { return "import.meta.hot"; }';
    expect(await transformHotModule(code, "/a.ts")).toBeDefined();
  });

  it("treats function exports as values when forwarding is off", async () => {
    const code = (await transformHotModule("export function f() {}", "/a.ts", { forwardFunctions: false }))!
      .code;
    expect(code).not.toContain(".fn(");
    expect(code).toContain('__harness_hmr__.value("f", f)');
    expect(code.startsWith('const __harness_hmr__ = __harness_hmr_create__(import.meta.hot, "/a.ts", "f=v");')).toBe(true);
  });

  it("leaves modules it cannot instrument untouched", async () => {
    expect(await transformHotModule("export const a = 1;\nawait Promise.resolve();", "/a.ts")).toBe(
      undefined,
    );
    expect(await transformHotModule("const x = 1;", "/a.ts")).toBe(undefined);
    expect(await transformHotModule("export const a = 1; import.meta.hot.accept();", "/a.ts")).toBe(
      undefined,
    );
    expect(await transformHotModule("export const = ;", "/a.ts")).toBe(undefined);
  });

  it("handles destructuring, re-exports, string names and anonymous defaults", async () => {
    const result = await transformHotModule(
      [
        "const o = { b: 1, c: [2] };",
        "export const { b, c: [d] } = o;",
        "const e = () => 1;",
        'export { e as "e-alias" };',
        'export * from "./star.ts";',
        'export { f as g } from "./named.ts";',
        "export default () => 1;",
      ].join("\n"),
      "/a.ts",
    );
    expect(result).toBeDefined();
    const code = result!.code;
    expect(code).toContain('const e = __harness_hmr__.fn("e", () => 1);');
    expect(code).toContain('__harness_hmr__.value("b", b)');
    expect(code).toContain('__harness_hmr__.value("d", d)');
    expect(code).toContain('const __harness_default = __harness_hmr__.fn("default", ({ default: () => 1 }).default);');
    expect(code).toContain("export { __harness_default as default };");
    expect(code).toContain("*=*@./star.ts");
    expect(code).toContain("g=f@./named.ts");
  });
});
