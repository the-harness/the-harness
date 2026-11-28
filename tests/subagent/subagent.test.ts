import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type CwdModule = typeof import("../../packages/cwd/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type MockLlmModule = typeof import("../../packages/mock-llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type SubagentModule = typeof import("../../packages/subagent/src/index.ts");
type SubagentToolModule = typeof import("../../packages/subagent-tool/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let contextModule: ContextModule;
let cwdModule: CwdModule;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let llm: LlmModule;
let mockLlm: MockLlmModule;
let modelProvider: ModelProviderModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let subagent: SubagentModule;
let subagentTool: SubagentToolModule;
let toolCallModule: ToolCallModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [
    agentLoop,
    contextModule,
    cwdModule,
    di,
    linkedTree,
    llm,
    mockLlm,
    modelProvider,
    modelSelection,
    sqlite,
    subagent,
    subagentTool,
    toolCallModule,
  ] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<CwdModule>("/packages/cwd/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<MockLlmModule>("/packages/mock-llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<SubagentModule>("/packages/subagent/src/index.ts"),
    harness.load<SubagentToolModule>("/packages/subagent-tool/src/index.ts"),
    harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createSession() {
  const root = di.createRootScope();
  root.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    modelProvider.ProviderManager,
    llm.LlmService,
    di.createDescriptor(cwdModule.CwdService, process.cwd()),
    di.createDescriptor(modelSelection.ModelSelectionService, {
      provider: "mock",
      model: "mock-model",
    }),
    subagent.AgentManager,
  ]);
  const providerScope = root.get(modelProvider.ProviderManager).create({ id: "mock" });
  providerScope.provide(
    llm.LlmProvider,
    di.createDescriptor(mockLlm.ScriptedMockLlmProvider, {
      provider: "mock",
      models: [{ id: "mock-model", name: "Mock", provider: "mock" }],
    }),
  );
  const mock = providerScope.get(llm.LlmProvider) as InstanceType<
    MockLlmModule["ScriptedMockLlmProvider"]
  >;

  const primary = root.get(subagent.AgentManager).create({ id: "primary" });
  primary.provideAll([
    di.createDescriptor(contextModule.Context, { id: "primary" }),
    di.createDescriptor(agentLoop.AgentLoop, { provider: "mock", model: "mock-model" }),
    toolCallModule.ToolCallService,
  ]);
  primary.run(() => {
    toolCallModule.useToolCall();
    subagentTool.useSubagentTool();
  });
  return { root, primary, mock };
}

async function runTool(
  scope: di.Scope,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const service = scope.get(toolCallModule.ToolCallService);
  const [result] = await service.execute(
    [
      llm.ToolCallBlock.create({
        id: `subagent-call-${Math.random().toString(36).slice(2)}`,
        name,
        arguments: JSON.stringify(args),
      }),
    ],
    signal,
  );
  return { text: llm.extractText(result!.content), isError: result!.isError === true };
}

describe("agent manager", () => {
  it("runs setup for each created agent and removes disposed scopes", () => {
    const root = di.createRootScope();
    root.provideAll([subagent.AgentManager]);
    try {
      const manager = root.get(subagent.AgentManager);
      const setups: string[] = [];
      manager.hooks.setup.use(async (_input, next) => {
        setups.push("setup");
        await next();
      });
      const first = manager.create({ id: "one" });
      const second = manager.create();
      expect(first.id).toBe("one");
      expect(second.id).toMatch(/^agent-\d+$/);
      expect(manager.agents.size).toBe(2);
      expect(setups).toEqual(["setup", "setup"]);
      expect(() => manager.create({ id: "one" })).toThrow("agent 'one' already exists");

      first.dispose();
      expect(manager.agents.has("one")).toBe(false);
      expect(manager.agents.has(second.id)).toBe(true);
      second.dispose();
      expect(manager.agents.size).toBe(0);

      const third = manager.create();
      expect(third.id).toMatch(/^agent-\d+$/);
      expect(third.id).not.toBe(second.id);
    } finally {
      root.dispose();
    }
  });

  it("delegates to a fresh child agent and returns its reply", async () => {
    const session = createSession();
    try {
      session.mock.enqueue({ text: "sub reply" });
      const result = await runTool(session.primary, "subagent", {
        prompt: "summarize the diff",
      });
      expect(result).toEqual({ isError: false, text: "[agent-1]\nsub reply" });
      expect(session.mock.requests).toHaveLength(1);
      expect(
        session.mock.requests[0]!.request.messages.map((message) =>
          llm.extractText(message.content),
        ),
      ).toContain("summarize the diff");
    } finally {
      session.root.dispose();
    }
  });

  it("reuses a named agent for follow-up messages and rejects forking into it", async () => {
    const session = createSession();
    try {
      session.mock.enqueue({ text: "sub reply" });
      session.mock.enqueue({ text: "follow up reply" });
      const first = await runTool(session.primary, "subagent", {
        prompt: "first",
        name: "worker",
      });
      expect(first).toEqual({ isError: false, text: "[worker]\nsub reply" });

      const followUp = await runTool(session.primary, "subagent", {
        prompt: "second",
        name: "worker",
      });
      expect(followUp).toEqual({ isError: false, text: "[worker]\nfollow up reply" });
      expect(session.mock.requests).toHaveLength(2);

      const forked = await runTool(session.primary, "subagent", {
        prompt: "third",
        name: "worker",
        fork: true,
      });
      expect(forked.isError).toBe(true);
      expect(forked.text).toContain("already exists; cannot fork into it");
    } finally {
      session.root.dispose();
    }
  });

  it("rejects a busy named agent without adding the rejected prompt to its context", async () => {
    const session = createSession();
    const reply = Promise.withResolvers<string>();
    try {
      const worker = session.root.get(subagent.AgentManager).create({ id: "worker" });
      worker.provideAll([
        di.createDescriptor(contextModule.Context, { id: "worker-context" }),
        agentLoop.AgentLoop,
      ]);
      const context = worker.get(contextModule.Context);
      session.mock.enqueue(() => reply.promise);

      const first = runTool(session.primary, "subagent", { prompt: "accepted", name: "worker" });
      await session.mock.waitForRequest(1);
      const second = await runTool(session.primary, "subagent", {
        prompt: "rejected",
        name: "worker",
      });
      expect(second).toEqual({
        isError: true,
        text: "loop is already running for context 'worker-context'",
      });
      expect(context.pending).toHaveLength(0);

      reply.resolve("only reply");
      await expect(first).resolves.toEqual({ isError: false, text: "[worker]\nonly reply" });
      expect(session.mock.requests).toHaveLength(1);
    } finally {
      reply.resolve("only reply");
      session.root.dispose();
    }
  });

  it("does not replay a named agent's previous reply after max_tokens", async () => {
    const session = createSession();
    try {
      const worker = session.root.get(subagent.AgentManager).create({ id: "worker" });
      worker.provideAll([
        di.createDescriptor(contextModule.Context, { id: "worker" }),
        agentLoop.AgentLoop,
      ]);
      session.mock.enqueue({ text: "previous reply" });
      session.mock.enqueue({ text: "incomplete reply", stopReason: "max_tokens" });
      const first = await runTool(session.primary, "subagent", { name: "worker", prompt: "first" });
      expect(first).toEqual({ isError: false, text: "[worker]\nprevious reply" });
      worker.get(contextModule.Context).batch();

      const second = await runTool(session.primary, "subagent", {
        name: "worker",
        prompt: "second",
      });
      expect(second).toEqual({ isError: false, text: "[worker] (max_tokens)" });
      expect(session.mock.requests).toHaveLength(2);
    } finally {
      session.root.dispose();
    }
  });
});
