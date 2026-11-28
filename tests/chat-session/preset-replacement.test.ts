import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type Di = typeof import("../../packages/di/src/index.ts");
type Llm = typeof import("../../packages/llm/src/index.ts");
type Presets = typeof import("../../packages/agent-preset/src/index.ts");

let harness: HarnessModules;
let modules: Record<string, any>;
let dir: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  const entries = await Promise.all(
    Object.entries({
      di: "/packages/di/src/index.ts",
      llm: "/packages/llm/src/index.ts",
      providers: "/packages/model-provider/src/index.ts",
      mock: "/packages/mock-llm/src/index.ts",
      presets: "/packages/agent-preset/src/index.ts",
      sessions: "/packages/session-manager/src/index.ts",
      sessionList: "/packages/session-catalog/src/index.ts",
      workspaces: "/packages/workspace-catalog/src/index.ts",
      images: "/packages/image-storage/src/index.ts",
      sqlite: "/packages/sqlite/src/index.ts",
      linkedTree: "/packages/linked-tree/src/index.ts",
      chat: "/packages/chat-session/src/index.ts",
      mcp: "/packages/mcp/src/index.ts",
      digest: "/packages/session-digest/src/node.ts",
      status: "/packages/session-status/src/node.ts",
      reactivity: "/packages/llm/node_modules/reactivity/dist/index.js",
    }).map(async ([key, path]) => [key, await harness.load(path)] as const),
  );
  modules = Object.fromEntries(entries);
  dir = mkdtempSync(join(tmpdir(), "chat-preset-"));
});

afterAll(async () => {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chat session presets", () => {
  it("runs the currently registered preset when a live session's setup re-runs", async () => {
    const { di, llm, providers, mock, presets, sessions, sessionList, workspaces, images, sqlite } =
      modules as { di: Di; llm: Llm; presets: Presets } & Record<string, any>;
    const scope = di.createRootScope();
    scope.provideAll([
      di.createDescriptor(sqlite.SqliteService, { path: join(dir, "chat.db") }),
      llm.LlmService,
      providers.ProviderManager,
      presets.AgentPresetRegistry,
      sessions.SessionManager,
      sessionList.SessionCatalog,
      workspaces.WorkspaceCatalog,
      images.ImageStorageService,
      modules.linkedTree.LinkedTree,
      modules.mcp.McpService,
      modules.digest.SessionDigestStore,
      modules.status.SessionStatusHostService,
    ]);
    scope.setup(() => modules.chat.useChatSessions());
    try {
      const providerScope = scope.get(providers.ProviderManager).create({ id: "mock" });
      providerScope.provide(
        llm.LlmProvider,
        di.createDescriptor(mock.ScriptedMockLlmProvider, {
          provider: "mock",
          models: [{ id: "mock-model", name: "Mock", provider: "mock" }],
        }),
      );
      const model = providerScope.get(llm.LlmProvider) as any;
      const calls: string[] = [];
      const version = modules.reactivity.shallowRef(1);
      // A hot update re-runs the setup that registered the preset and registers a new instance.
      scope.setup(() => {
        const current = version.value;
        di.inject(presets.AgentPresetRegistry).usePreset({
          id: "probe",
          name: "Probe",
          setup: () => calls.push(`v${current}`),
        } as never);
      });

      const chat = scope.get(sessions.SessionManager).acquire("s").get(modules.chat.ChatSession);
      chat.pending.items.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hi" })] }),
      );
      model.enqueue({ text: "ok" });
      for await (const _event of chat.stream({ modelId: "mock-model", presetId: "probe" }));
      expect(calls).toEqual(["v1"]);

      version.value = 2;
      expect(calls.at(-1)).toBe("v2");
    } finally {
      scope.dispose();
    }
  });
});
