import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("measures each assistant reply without counting its cached input again", async () => {
  const harness = await createHarnessModules();
  const [
    { AgentLoop },
    { Context },
    { ContextSizeService, useContextSize },
    { createDescriptor, createRootScope },
    { LinkedTree },
    { AssistantMessage, LlmProvider, LlmService, TextBlock, UserMessage },
    { ScriptedMockLlmProvider },
    { ProviderManager },
    { ModelSelectionService },
    { SqliteService },
  ] = await Promise.all([
    harness.load<typeof import("../../packages/agent-loop/src/index.ts")>(
      "/packages/agent-loop/src/index.ts",
    ),
    harness.load<typeof import("../../packages/context/src/index.ts")>(
      "/packages/context/src/index.ts",
    ),
    harness.load<typeof import("../../packages/context-size/src/index.ts")>(
      "/packages/context-size/src/index.ts",
    ),
    harness.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
    harness.load<typeof import("../../packages/linked-tree/src/index.ts")>(
      "/packages/linked-tree/src/index.ts",
    ),
    harness.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
    harness.load<typeof import("../../packages/mock-llm/src/index.ts")>(
      "/packages/mock-llm/src/index.ts",
    ),
    harness.load<typeof import("../../packages/model-provider/src/index.ts")>(
      "/packages/model-provider/src/index.ts",
    ),
    harness.load<typeof import("../../packages/model-selection/src/index.ts")>(
      "/packages/model-selection/src/index.ts",
    ),
    harness.load<typeof import("../../packages/sqlite/src/index.ts")>(
      "/packages/sqlite/src/index.ts",
    ),
  ]);
  const scope = createRootScope();
  try {
    scope.provideAll([
      AgentLoop,
      Context,
      ContextSizeService,
      LinkedTree,
      LlmService,
      ProviderManager,
      createDescriptor(ModelSelectionService, { provider: "mock", model: "mock" }),
      createDescriptor(SqliteService, { path: ":memory:" }),
    ]);
    const providerScope = scope.get(ProviderManager).create({ id: "mock" });
    providerScope.provide(createDescriptor(ScriptedMockLlmProvider));
    const provider = providerScope.get(LlmProvider) as InstanceType<typeof ScriptedMockLlmProvider>;
    scope.setup(useContextSize);
    const context = scope.get(Context);
    const loop = scope.get(AgentLoop);
    for (const outputTokens of [5, 7]) {
      provider.enqueue({
        text: "reply",
        usage: { inputTokens: 20, cacheReadTokens: 100_000, outputTokens },
      });
      context.pending.push(UserMessage.create({ content: [TextBlock.create({ text: "hello" })] }));
      expect(await loop.run()).toBe("completed");
    }

    const messages = [...context.pending];
    for await (const batch of context.readBackward()) messages.push(...batch.messages);
    const size = scope.get(ContextSizeService);
    expect(
      messages
        .filter((message) => message instanceof AssistantMessage)
        .map((message) => size.sizeOf(message))
        .sort((a, b) => a - b),
    ).toEqual([5, 7]);
    await scope.get(SqliteService).flush();
  } finally {
    scope.dispose();
    await harness.close();
  }
});
