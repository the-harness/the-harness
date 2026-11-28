import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type MockModule = typeof import("../../packages/mock-llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type ReactivityModule = typeof import("reactivity");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let contextModule: ContextModule;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let llm: LlmModule;
let mock: MockModule;
let modelProvider: ModelProviderModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let reactivity: ReactivityModule;
let tempDir: string;
let constructionScope: InstanceType<DiModule["Scope"]>;
let MockLlmService: new () => InstanceType<LlmModule["LlmService"]>;

beforeAll(async () => {
  harness = await createHarnessModules();
  [
    agentLoop,
    contextModule,
    di,
    linkedTree,
    llm,
    mock,
    modelProvider,
    modelSelection,
    sqlite,
    reactivity,
  ] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<MockModule>("/packages/mock-llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<ReactivityModule>("/packages/llm/node_modules/reactivity/dist/index.js"),
  ]);
  MockLlmService = class extends llm.LlmService {
    provider!: InstanceType<MockModule["ScriptedMockLlmProvider"]>;

    override stream(request: unknown) {
      return this.provider.stream(request as never);
    }
  };
  tempDir = mkdtempSync(join(tmpdir(), "harness-run-stop-"));
  constructionScope = di.createRootScope({ id: "run-stop-construction" });
});

afterAll(async () => {
  constructionScope.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  await harness.close();
});

function openRuntime(
  dbPath: string,
  provider: InstanceType<MockModule["ScriptedMockLlmProvider"]>,
) {
  const sessionId = "run-stop-session";
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: dbPath }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: sessionId }),
    modelProvider.ProviderManager,
    [llm.LlmService, di.createDescriptor(MockLlmService)],
    di.createDescriptor(modelSelection.ModelSelectionService, {
      provider: "mock",
      model: "mock",
    }),
    agentLoop.AgentLoop,
  ]);
  (scope.get(llm.LlmService) as InstanceType<typeof MockLlmService>).provider = provider;
  return {
    scope,
    sessionId,
    context: scope.get(contextModule.Context),
    loop: scope.get(agentLoop.AgentLoop),
    sqliteService: scope.get(sqlite.SqliteService),
    async close() {
      await this.sqliteService.close();
      scope.dispose();
    },
  };
}

function newMock(): InstanceType<MockModule["ScriptedMockLlmProvider"]> {
  return constructionScope.createInstance(
    di.createDescriptor(mock.ScriptedMockLlmProvider, {
      providerId: "mock",
      models: [{ id: "mock", name: "Mock" }],
    }),
  );
}

function stopMessages(context: InstanceType<ContextModule["Context"]>) {
  return context.pending.filter((message) => message instanceof agentLoop.RunStopMessage) as Array<
    InstanceType<AgentLoopModule["RunStopMessage"]>
  >;
}

describe("agent loop run stop records", () => {
  it("records a completed stop after the assistant reply and hides it from the next request", async () => {
    const provider = newMock();
    provider.enqueue({ text: "hello" });
    const runtime = openRuntime(":memory:", provider);
    try {
      runtime.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hi" })] }),
      );
      expect(await runtime.loop.run()).toBe("completed");
      expect(provider.requests).toHaveLength(1);

      const stops = stopMessages(runtime.context);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.stopReason).toBe("completed");
      expect(stops[0]!.meta.get(agentLoop.SupplementaryField)).toBe(true);
      expect(runtime.context.pending.filter((m) => m instanceof llm.AssistantMessage)).toHaveLength(
        1,
      );
      expect(runtime.context.pending.some((m) => m instanceof llm.UserMessage)).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("unbatches and records max_tokens when the provider stops at the token limit", async () => {
    const provider = newMock();
    provider.enqueue({ text: "partial", stopReason: "max_tokens" });
    const runtime = openRuntime(":memory:", provider);
    try {
      runtime.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "write" })] }),
      );
      expect(await runtime.loop.run()).toBe("max_tokens");
      expect(runtime.context.batchCount).toBe(0);
      expect(runtime.context.pending.filter((m) => m instanceof llm.UserMessage)).toHaveLength(1);
      const stops = stopMessages(runtime.context);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.stopReason).toBe("max_tokens");
    } finally {
      await runtime.close();
    }
  });

  it("tracks isRunning reactively across a run", async () => {
    const provider = newMock();
    provider.enqueue({ text: "hello" });
    const runtime = openRuntime(":memory:", provider);
    const observed: boolean[] = [];
    const stop = reactivity.watchSyncEffect(() => {
      observed.push(runtime.loop.isRunning);
    });
    try {
      runtime.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hi" })] }),
      );
      expect(await runtime.loop.run()).toBe("completed");
      expect(observed).toEqual([false, true, false]);
    } finally {
      stop();
      await runtime.close();
    }
  });

  it("records aborted when the run is cancelled while streaming", async () => {
    const provider = newMock();
    provider.enqueue(async (ctx) => {
      await ctx.waitForAbort();
      return { text: "never delivered" };
    });
    const runtime = openRuntime(":memory:", provider);
    try {
      runtime.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hi" })] }),
      );
      const running = runtime.loop.run();
      await provider.waitForRequest(1);
      runtime.loop.abort();
      expect(await running).toBe("aborted");
      const stops = stopMessages(runtime.context);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.stopReason).toBe("aborted");
      expect(runtime.context.pending.filter((m) => m instanceof llm.UserMessage)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("persists the stop record with its variant chain across a context reload", async () => {
    const dbPath = join(tempDir, "run-stop.db");
    const provider = newMock();
    provider.enqueue({ text: "persisted" });
    const first = openRuntime(dbPath, provider);
    await first.context.pending.push(
      llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hi" })] }),
    );
    expect(await first.loop.run()).toBe("completed");
    await first.close();

    const original = stopMessages(first.context)[0]!;
    expect(original.id).toBeTruthy();

    const second = openRuntime(dbPath, newMock());
    try {
      const restored = second.context.pending.filter(
        (message) => message instanceof agentLoop.RunStopMessage,
      ) as Array<InstanceType<AgentLoopModule["RunStopMessage"]>>;
      expect(restored).toHaveLength(1);
      expect(restored[0]).toBeInstanceOf(agentLoop.RunStopMessage);
      expect(restored[0]!.stopReason).toBe("completed");
      expect(restored[0]!.meta.get(agentLoop.SupplementaryField)).toBe(true);
      const assistant = second.context.pending.find((m) => m instanceof llm.AssistantMessage);
      expect(llm.extractText(assistant!.content)).toBe("persisted");
    } finally {
      await second.close();
    }
  });
});
