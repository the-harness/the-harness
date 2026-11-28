import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The app's own vite-plus copy, so environments pass the app config's instanceof checks as in `vp dev`.
import { createServer, isRunnableDevEnvironment } from "../../apps/web/node_modules/vite-plus/dist/index.js";
import { createServerModuleLoader } from "../../apps/web/server-modules.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { serverCalls } from "../helpers/server-calls.ts";

type DevModule = typeof import("../../apps/web/src/server/dev.ts");

const repo = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = join(repo, "apps/web/");
const tempDir = mkdtempSync(join(tmpdir(), "harness-live-hmr-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Edited sources are served by a plugin instead of being written to disk, so test files running
// in parallel against the same repo never see them.
async function startApp() {
  const overrides = new Map<string, string>();
  const hmrErrors: string[] = [];
  const fullReloads: unknown[] = [];
  const originalError = console.error;
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    hmrErrors.push(args.map(String).join(" "));
    originalError(...args);
  });
  vi.stubEnv("HARNESS_CHAT_DB", join(mkdtempSync(join(tempDir, "app-")), "chat.db"));
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);

  const server = await createServer({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { watch: null, port: 0 },
    plugins: [
      {
        name: "test:source-overrides",
        enforce: "pre",
        load(id: string) {
          return overrides.get(id.split("?")[0]!) ?? null;
        },
      },
    ],
  });
  cleanups.push(async () => {
    await server.close();
    consoleError.mockRestore();
    vi.unstubAllEnvs();
  });
  await server.listen();
  const ssr = server.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("ssr runner unavailable");
  const send = ssr.hot.send.bind(ssr.hot);
  ssr.hot.send = ((...args: Parameters<typeof send>) => {
    const [payload] = args;
    if (typeof payload === "object" && payload.type === "full-reload") fullReloads.push(payload);
    return send(...args);
  }) as typeof send;

  const appLoad = createServerModuleLoader(server);
  const loadDev = () => appLoad<DevModule>("/src/server/dev.ts");
  const load = <T>(id: string) => ssr.runner.import(id) as Promise<T>;

  function edit(rel: string, from: string, to: string, emit = true) {
    const file = join(repo, rel);
    const source = overrides.get(file) ?? readFileSync(file, "utf8");
    if (!source.includes(from)) throw new Error(`anchor not found in ${rel}: ${from}`);
    overrides.set(file, source.replace(from, to));
    if (emit) server.watcher.emit("change", file);
  }

  const dev = await loadDev();
  return {
    server,
    ssr,
    scope: dev.scope,
    loadDev,
    load,
    edit,
    hmrErrors: () => hmrErrors.filter((message) => message.includes("[hmr]")),
    fullReloads,
  };
}

type App = Awaited<ReturnType<typeof startApp>>;

async function startChat(app: App) {
  type Di = typeof import("../../packages/di/src/index.ts");
  type Llm = typeof import("../../packages/llm/src/index.ts");
  type Providers = typeof import("../../packages/model-provider/src/index.ts");
  type MockLlm = typeof import("../../packages/mock-llm/src/index.ts");
  type ChatSessionModule = typeof import("../../packages/chat-session/src/index.ts");
  type SessionManagerModule = typeof import("../../packages/session-manager/src/index.ts");
  const [di, llm, providers, mockLlm, chatSession, sessionManager] = await Promise.all([
    app.load<Di>("@harness/di"),
    app.load<Llm>("@harness/llm"),
    app.load<Providers>("@harness/model-provider"),
    app.load<MockLlm>(join(repo, "packages/mock-llm/src/index.ts")),
    app.load<ChatSessionModule>("@harness/chat-session"),
    app.load<SessionManagerModule>("@harness/session-manager"),
  ]);
  const providerScope = app.scope.get(providers.ProviderManager).create({ id: "mock" });
  providerScope.provide(
    llm.LlmProvider,
    di.createDescriptor(mockLlm.ScriptedMockLlmProvider, {
      provider: "mock",
      models: [{ id: "mock-model", name: "Mock", provider: "mock" }],
    }),
  );
  const mock = providerScope.get(llm.LlmProvider) as InstanceType<
    MockLlm["ScriptedMockLlmProvider"]
  >;
  const current = () =>
    app.scope.get(sessionManager.SessionManager).acquire("live-hmr").get(chatSession.ChatSession);
  const chat = current();

  type Event = { type: string; [key: string]: unknown };
  async function turn(steps: Parameters<typeof mock.enqueue>[0][]) {
    for (const step of steps) mock.enqueue(step);
    chat.pending.items.push(
      llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "go" })] }),
    );
    const events: Event[] = [];
    for await (const event of chat.stream({ modelId: "mock-model" }))
      events.push(event as Event);
    return events;
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const events = await turn([
      { toolCalls: [{ id: `call-${Math.random()}`, name, arguments: args }] },
      { text: "done" },
    ]);
    const result = events.map(toolResult).find((item) => item !== undefined);
    return result ? `${result.isError ? "error:" : ""}${result.output}` : undefined;
  }
  await turn([{ text: "ready" }]);
  return { chat, current, context: chat.context, turn, callTool, mock };
}

type Terminal = typeof import("../../packages/terminal/src/index.ts");
type ScopeInternals = {
  readonly _slots: Map<unknown, unknown>;
  readonly _nodes: Map<unknown, { readonly instance: { readonly value: unknown } }>;
};

const waitLong = { timeout: 10_000, interval: 100 };
const scopeRel = "apps/web/src/server/scope.ts";

const lsProbe = [
  "packages/pi-tools/src/ls.ts",
  "      signal.throwIfAborted();\n      const dirPath",
  '      if (path === "__hmr_probe__") return "probe:v2";\n      signal.throwIfAborted();\n      const dirPath',
] as const;

function presetProbe(key: string) {
  return [
    "packages/pi-coding-agent/src/index.ts",
    "  useToolCall();\n",
    `  useToolCall();\n  (globalThis as any)[${JSON.stringify(key)}] = ((globalThis as any)[${JSON.stringify(key)}] ?? 0) + 1;\n`,
  ] as const;
}

function counter(key: string) {
  const store = globalThis as unknown as Record<string, number | undefined>;
  delete store[key];
  cleanups.push(async () => {
    delete store[key];
  });
  return () => store[key] ?? 0;
}

async function expectSameApp(app: App) {
  expect((await app.loadDev()).scope).toBe(app.scope);
  expect(app.scope.isDisposed).toBe(false);
  expect(app.fullReloads).toEqual([]);
  expect(app.hmrErrors()).toEqual([]);
}

type ToolResultWire = {
  readonly $variants: readonly string[];
  readonly isError?: boolean;
  readonly content: readonly { readonly text?: string }[];
};

function toolResult(event: { type: string; [key: string]: unknown }) {
  const message = event["message"] as ToolResultWire | undefined;
  if (event.type !== "message" || !message?.$variants.includes("core:llm:tool")) return undefined;
  return {
    isError: Boolean(message.isError),
    output: message.content.map((block) => block.text ?? "").join(""),
  };
}

function textDelta(event: { type: string; [key: string]: unknown }) {
  const chunk = event["chunk"] as { type: string; delta?: string } | undefined;
  return event.type === "chunk" && chunk?.type === "text_delta" ? chunk.delta : undefined;
}

function summary(events: readonly { type: string; [key: string]: unknown }[]) {
  return events
    .map((event) => {
      const result = toolResult(event);
      if (result) return `result:${result.output}`;
      if (event.type === "error") return `error:${String(event["message"])}`;
      return textDelta(event) ?? event.type;
    })
    .join(" | ");
}

describe("live HMR of the web dev server", { timeout: 30_000 }, () => {
  it("delivers an edited pi-tools tool to a live chat session", async () => {
    const app = await startApp();
    const live = await startChat(app);
    expect(await live.callTool("ls", { path: "__hmr_probe__" })).toMatch(/^error:/);

    app.edit(...lsProbe);
    await vi.waitFor(
      async () => expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2"),
      waitLong,
    );

    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("re-runs an edited preset setup in the live chat session", async () => {
    const runs = counter("__liveHmrPresetSetup");
    const app = await startApp();
    const live = await startChat(app);
    app.edit(...lsProbe);
    await vi.waitFor(
      async () => expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2"),
      waitLong,
    );

    app.edit(...presetProbe("__liveHmrPresetSetup"));
    await vi.waitFor(() => expect(runs()).toBeGreaterThan(0), waitLong);

    expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2");
    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("serves an edited RPC handler and keeps the chat session", async () => {
    type Transport = typeof import("../../packages/transport/src/index.ts");
    const app = await startApp();
    const live = await startChat(app);
    const { ServerTransport } = await app.load<Transport>("@harness/transport");
    const rpcServer = serverCalls(app.scope.get(ServerTransport));

    app.edit(
      "packages/ui-chat/src/server/handlers.ts",
      "return { id, name, description, icon };",
      "return { id, name: `${name} v2`, description, icon };",
    );
    await vi.waitFor(async () => {
      const presets = (await rpcServer.handleCall("chat.listPresets", [], undefined)) as {
        name: string;
      }[];
      expect(presets.length).toBeGreaterThan(0);
      expect(presets.every((preset) => preset.name.endsWith(" v2"))).toBe(true);
    }, waitLong);

    expect(live.current()).toBe(live.chat);
    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("keeps the DeepSeek provider scope across an RPC handler edit", async () => {
    type Providers = typeof import("../../packages/model-provider/src/index.ts");
    type Transport = typeof import("../../packages/transport/src/index.ts");
    const app = await startApp();
    const live = await startChat(app);
    const { ProviderManager } = await app.load<Providers>("@harness/model-provider");
    const { ServerTransport } = await app.load<Transport>("@harness/transport");
    const deepseek = app.scope.get(ProviderManager).providers.get("deepseek");
    expect(deepseek).toBeDefined();

    app.edit(
      "packages/ui-chat/src/server/handlers.ts",
      "return { id, name, description, icon };",
      "return { id, name: `${name} v2`, description, icon };",
    );
    const rpcServer = serverCalls(app.scope.get(ServerTransport));
    await vi.waitFor(async () => {
      const presets = (await rpcServer.handleCall("chat.listPresets", [], undefined)) as {
        name: string;
      }[];
      expect(presets.some((preset) => preset.name.endsWith(" v2"))).toBe(true);
    }, waitLong);

    expect(app.scope.get(ProviderManager).providers.get("deepseek")).toBe(deepseek);
    expect(deepseek!.isDisposed).toBe(false);
    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("provides a non-exported service added to the server composition and releases it when removed, rebuilding nothing else", async () => {
    const probeKey = "__liveHmrProbeService";
    const store = globalThis as unknown as Record<string, (new () => object) | undefined>;
    delete store[probeKey];
    cleanups.push(async () => {
      delete store[probeKey];
    });
    const app = await startApp();
    const live = await startChat(app);
    app.edit(...lsProbe);
    await vi.waitFor(
      async () => expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2"),
      waitLong,
    );
    const internals = app.scope as unknown as ScopeInternals;
    const instances = new Map(
      [...internals._slots.keys()].map((id) => [id, internals._nodes.get(id)?.instance.value]),
    );
    const rebuilt = () =>
      [...instances]
        .filter(
          ([id, before]) =>
            before !== undefined && internals._nodes.get(id)?.instance.value !== before,
        )
        .map(([id]) => (id as { name?: string }).name ?? String(id));
    expect([...instances.values()].filter((value) => value !== undefined).length).toBeGreaterThan(5);

    app.edit(
      scopeRel,
      "export function createServerScope",
      `class HmrProbeService {}\n(globalThis as any).${probeKey} = HmrProbeService;\n\nexport function createServerScope`,
    );
    app.edit(scopeRel, "    TerminalService,\n  ]);", "    TerminalService,\n    HmrProbeService,\n  ]);");
    await vi.waitFor(() => {
      const Probe = store[probeKey];
      expect(Probe).toBeDefined();
      expect(app.scope.get(Probe!)).toBeInstanceOf(Probe!);
    }, waitLong);
    expect(rebuilt()).toEqual([]);
    expect(live.current()).toBe(live.chat);
    expect(live.current().context).toBe(live.context);
    expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2");
    await expectSameApp(app);

    app.edit(scopeRel, "    TerminalService,\n    HmrProbeService,\n  ]);", "    TerminalService,\n  ]);");
    await vi.waitFor(() => expect(() => app.scope.get(store[probeKey]!)).toThrow(), waitLong);
    expect(rebuilt()).toEqual([]);
    expect(live.current()).toBe(live.chat);
    expect(live.current().context).toBe(live.context);
    expect(await live.callTool("ls", { path: "__hmr_probe__" })).toBe("probe:v2");
    await expectSameApp(app);
  });

  it("recreates the server scope and disposes the old one when the composition gains an export", async () => {
    type ScopeModule = { readonly HmrProbeService: new () => object };
    const app = await startApp();

    app.edit(
      scopeRel,
      "export function createServerScope",
      "export class HmrProbeService {}\n\nexport function createServerScope",
    );
    app.edit(scopeRel, "    TerminalService,\n  ]);", "    TerminalService,\n    HmrProbeService,\n  ]);");
    let next: DevModule["scope"] | undefined;
    await vi.waitFor(async () => {
      next = (await app.loadDev()).scope;
      expect(next).not.toBe(app.scope);
    }, waitLong);

    expect(app.scope.isDisposed).toBe(true);
    expect(next!.isDisposed).toBe(false);
    const { HmrProbeService } = await app.load<ScopeModule>("/src/server/scope.ts");
    expect(next!.get(HmrProbeService)).toBeInstanceOf(HmrProbeService);
    expect(app.fullReloads).toEqual([]);
    expect(app.hmrErrors()).toEqual([]);
  });

  it("lands a tool edit made while the model request of a running turn is pending", async () => {
    const app = await startApp();
    const live = await startChat(app);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => (requested = resolve));
    const running = live.turn([
      async () => {
        requested();
        await gate;
        return { toolCalls: [{ id: "pending", name: "ls", arguments: { path: "__hmr_probe__" } }] };
      },
      { text: "done" },
    ]);
    await pending;

    const evaluations = counter("__liveHmrLsEvaluated");
    app.edit(...lsProbe, false);
    app.edit(
      lsProbe[0],
      "export function useLsTool",
      "(globalThis as any).__liveHmrLsEvaluated = ((globalThis as any).__liveHmrLsEvaluated ?? 0) + 1;\n\nexport function useLsTool",
    );
    await vi.waitFor(() => expect(evaluations()).toBeGreaterThan(0), waitLong);
    // Let the runtime apply the evaluated module before the model answers.
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    const events = await running;

    expect(summary(events)).toContain("result:probe:v2");
    expect(events.some((event) => textDelta(event) === "done")).toBe(true);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("re-runs the preset setup while a tool call of a running turn executes", async () => {
    const runs = counter("__liveHmrPresetDuringTool");
    const app = await startApp();
    const live = await startChat(app);
    const running = live.turn([
      { toolCalls: [{ id: "slow", name: "bash", arguments: { command: "sleep 2; echo slow-done" } }] },
      { text: "done" },
    ]);
    let settled = false;
    void running.finally(() => (settled = true));
    await vi.waitFor(() => expect(live.mock.requests.length).toBeGreaterThanOrEqual(2), waitLong);
    await new Promise((resolve) => setTimeout(resolve, 300));

    app.edit(...presetProbe("__liveHmrPresetDuringTool"));
    await vi.waitFor(() => expect(runs()).toBeGreaterThan(0), { timeout: 1_500, interval: 50 });
    expect(settled).toBe(false);
    const events = await running;

    expect(summary(events)).toContain("slow-done");
    expect(events.some((event) => textDelta(event) === "done")).toBe(true);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(live.current().context).toBe(live.context);
    await expectSameApp(app);
  });

  it("disposes the previous server scope when dev.ts itself is edited", async () => {
    const app = await startApp();
    const first = await app.loadDev();
    app.edit("apps/web/src/server/dev.ts", "export const scope", "// touched\nexport const scope");
    let next: DevModule | undefined;
    await vi.waitFor(async () => {
      next = await app.loadDev();
      expect(next).not.toBe(first);
    }, waitLong);

    expect(first.scope.isDisposed).toBe(true);
    expect(next!.scope.isDisposed).toBe(false);
    expect(app.fullReloads).toEqual([]);
    expect(app.hmrErrors()).toEqual([]);
  });

  it("disposes the server scope and ends its terminals on a full reload", async () => {
    const app = await startApp();
    const { TerminalService } = await app.load<Terminal>("@harness/terminal");
    const terminals = app.scope.get(TerminalService);
    const base = `http://localhost:${(app.server.httpServer!.address() as { port: number }).port}`;
    const created = (await (
      await fetch(`${base}/api/terminals`, { method: "POST", body: "{}" })
    ).json()) as { id?: string };
    expect(created.id).toBeDefined();
    expect(terminals.list()).toHaveLength(1);

    app.ssr.hot.send({ type: "full-reload" });
    let next: DevModule | undefined;
    await vi.waitFor(async () => {
      next = await app.loadDev();
      expect(next.scope).not.toBe(app.scope);
    }, waitLong);

    expect(app.scope.isDisposed).toBe(true);
    expect(terminals.list()).toEqual([]);
    expect(next!.scope.isDisposed).toBe(false);
    expect(await (await fetch(`${base}/api/terminals`)).json()).toEqual([]);
    expect(app.hmrErrors()).toEqual([]);
  });
});
