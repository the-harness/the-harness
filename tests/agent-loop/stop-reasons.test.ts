import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type MockLlmModule = typeof import("../../packages/mock-llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let contextModule: ContextModule;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let llm: LlmModule;
let mockLlm: MockLlmModule;
let modelProvider: ModelProviderModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let toolCallModule: ToolCallModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [
    agentLoop,
    contextModule,
    di,
    linkedTree,
    llm,
    mockLlm,
    modelProvider,
    modelSelection,
    sqlite,
    toolCallModule,
  ] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<MockLlmModule>("/packages/mock-llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createScope(options: { maxSteps?: number } = {}) {
  const root = di.createRootScope();
  root.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: "stop-reasons" }),
    modelProvider.ProviderManager,
    llm.LlmService,
    di.createDescriptor(modelSelection.ModelSelectionService, {
      provider: "mock",
      model: "mock-model",
    }),
    toolCallModule.ToolCallService,
    di.createDescriptor(agentLoop.AgentLoop, { maxSteps: options.maxSteps }),
  ]);
  const providerScope = root.get(modelProvider.ProviderManager).create({ id: "mock" });
  providerScope.provide(
    llm.LlmProvider,
    di.createDescriptor(mockLlm.ScriptedMockLlmProvider, {
      provider: "mock",
      models: [{ id: "mock-model", name: "Mock", provider: "mock" }],
    }),
  );
  return {
    root,
    context: root.get(contextModule.Context),
    loop: root.get(agentLoop.AgentLoop),
    mock: providerScope.get(llm.LlmProvider) as InstanceType<
      MockLlmModule["ScriptedMockLlmProvider"]
    >,
  };
}

function user(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

describe("agent loop stop reasons", () => {
  it("returns max_steps after the configured budget without an extra request", async () => {
    const opened = createScope({ maxSteps: 1 });
    try {
      opened.root.run(() =>
        opened.loop.hooks.handleOutput.use(async (_input, next) => {
          opened.context.pending.push(user("again"));
          await next();
        }),
      );
      opened.mock.enqueue({ text: "first" });
      opened.mock.enqueue({ text: "second" });
      opened.context.pending.push(user("one"));

      expect(await opened.loop.run()).toBe("max_steps");
      expect(opened.mock.requests).toHaveLength(1);
      expect(opened.context.batchCount).toBe(1);
      expect(
        opened.context.pending
          .filter((message) => message instanceof llm.AssistantMessage)
          .map((message) => llm.extractText(message.content)),
      ).toEqual(["first"]);
    } finally {
      opened.root.dispose();
    }
  });

  it("returns max_tokens and restores the uncommitted user input", async () => {
    const opened = createScope();
    try {
      opened.mock.enqueue({ text: "partial", stopReason: "max_tokens" });
      opened.context.pending.push(user("truncated request"));

      expect(await opened.loop.run()).toBe("max_tokens");
      expect(opened.context.batchCount).toBe(0);
      expect(
        opened.context.pending
          .filter((m) => m instanceof llm.UserMessage)
          .map((m) => llm.extractText(m.content)),
      ).toEqual(["truncated request"]);
    } finally {
      opened.root.dispose();
    }
  });

  it("unbatches and rejects when a provider error is unhandled", async () => {
    const opened = createScope();
    try {
      opened.mock.enqueue({ error: { message: "provider boom" } });
      opened.context.pending.push(user("fails"));

      await expect(opened.loop.run()).rejects.toThrow("provider boom");
      expect(opened.context.batchCount).toBe(0);
      expect(
        opened.context.pending
          .filter((m) => m instanceof llm.UserMessage)
          .map((m) => llm.extractText(m.content)),
      ).toEqual(["fails"]);
    } finally {
      opened.root.dispose();
    }
  });

  it("retries through handleError without consuming the step budget twice", async () => {
    const opened = createScope({ maxSteps: 1 });
    try {
      let errors = 0;
      opened.root.run(() =>
        opened.loop.hooks.handleError.use(async () => {
          errors += 1;
          opened.context.unbatch();
        }),
      );
      opened.mock.enqueue({ error: { message: "retryable" } });
      opened.mock.enqueue({ text: "recovered" });
      opened.context.pending.push(user("retry me"));

      expect(await opened.loop.run()).toBe("completed");
      expect(errors).toBe(1);
      expect(opened.mock.requests).toHaveLength(2);
      expect(
        opened.context.pending
          .filter((message) => message instanceof llm.AssistantMessage)
          .map((message) => llm.extractText(message.content)),
      ).toEqual(["recovered"]);
    } finally {
      opened.root.dispose();
    }
  });
});
