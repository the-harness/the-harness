import type { CodexCompactionOptions } from "../../packages/codex-compaction/src/index.ts";
import type { MockStep } from "../../packages/mock-llm/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";

export async function createCompactionHarness() {
  const modules = await createHarnessModules();
  const [agent, codex, compaction, context, size, di, llm, tree, mock, provider, selection, sqlite] =
    await Promise.all([
      modules.load<typeof import("../../packages/agent-loop/src/index.ts")>(
        "/packages/agent-loop/src/index.ts",
      ),
      modules.load<typeof import("../../packages/codex-compaction/src/index.ts")>(
        "/packages/codex-compaction/src/index.ts",
      ),
      modules.load<typeof import("../../packages/pi-compaction/src/index.ts")>(
        "/packages/pi-compaction/src/index.ts",
      ),
      modules.load<typeof import("../../packages/context/src/index.ts")>(
        "/packages/context/src/index.ts",
      ),
      modules.load<typeof import("../../packages/context-size/src/index.ts")>(
        "/packages/context-size/src/index.ts",
      ),
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/linked-tree/src/index.ts")>(
        "/packages/linked-tree/src/index.ts",
      ),
      modules.load<typeof import("../../packages/mock-llm/src/index.ts")>(
        "/packages/mock-llm/src/index.ts",
      ),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
      modules.load<typeof import("../../packages/model-selection/src/index.ts")>(
        "/packages/model-selection/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);

  function open(options: CodexCompactionOptions = {}, path = ":memory:", ...steps: MockStep[]) {
    const scope = di.createRootScope();
    scope.provideAll([
      di.createDescriptor(sqlite.SqliteService, { path }),
      tree.LinkedTree,
      provider.ProviderManager,
      llm.LlmService,
      size.ContextSizeService,
      di.createDescriptor(selection.ModelSelectionService, { provider: "mock", model: "mock" }),
      di.createDescriptor(context.Context, { id: "codex-compaction" }),
      [compaction.PiCompactionService, di.createDescriptor(codex.CodexCompactionService, options)],
      agent.AgentLoop,
    ]);
    const modelScope = scope.get(provider.ProviderManager).create({ id: "mock" });
    modelScope.provide(llm.LlmProvider, mock.ScriptedMockLlmProvider);
    const model = modelScope.get(llm.LlmProvider) as InstanceType<
      typeof mock.ScriptedMockLlmProvider
    >;
    model.enqueue(...steps);
    scope.run(() => codex.useCodexCompaction(options));
    return {
      scope,
      context: scope.get(context.Context),
      compaction: scope.get(compaction.PiCompactionService),
      loop: scope.get(agent.AgentLoop),
      model,
      async close() {
        const database = scope.get(sqlite.SqliteService);
        scope.dispose();
        await database.close();
      },
    };
  }

  const user = (text: string) =>
    llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
  return { agent, codex, compaction, llm, open, user, close: () => modules.close() };
}
