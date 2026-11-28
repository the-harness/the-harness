import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("keeps a DeepSeek stream's model configuration through a catalog refresh", async () => {
  const modules = await createHarnessModules();
  try {
    const [deepseek, di, llm, providers] = await Promise.all([
      modules.load<typeof import("../../packages/deepseek/src/index.ts")>(
        "/packages/deepseek/src/index.ts",
      ),
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
    ]);
    const root = di.createRootScope();
    try {
      root.provideAll([providers.ProviderManager, llm.LlmService]);
      let promptMode = "in-history";
      let maxOutputTokens = 200;
      const requests: unknown[] = [];
      root.setup(() =>
        deepseek.useDeepSeekProvider({
          baseUrl: "https://fixture.invalid",
          apiKey: "",
          models: [],
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname === "/models") {
              return Response.json({
                data: [
                  {
                    id: "model-fixture",
                    max_output_tokens: maxOutputTokens,
                    api_capabilities: { anthropic_messages: { system_prompt_update: promptMode } },
                  },
                ],
              });
            }
            requests.push(await request.json());
            return new Response('data: {"type":"message_stop"}\n\n');
          },
        }),
      );
      const scope = root.get(providers.ProviderManager).providers.get("deepseek")!;
      const provider = scope.get(llm.LlmProvider) as InstanceType<typeof deepseek.DeepSeekLlmProvider>;
      const service = root.get(llm.LlmService);
      const blocks = (text: string) => [llm.TextBlock.create({ text })];
      const request = {
        provider: "deepseek",
        model: "model-fixture",
        systemPrompt: "Base",
        messages: [
          llm.SystemMessage.create({ sectionId: "workspace", content: blocks("Original") }),
          llm.UserMessage.create({ content: blocks("First question") }),
          llm.SystemMessage.create({ sectionId: "workspace", content: blocks("Updated") }),
          llm.AssistantMessage.create({
            provider: "deepseek",
            model: "model-fixture",
            content: blocks("First answer"),
          }),
          llm.UserMessage.create({ content: blocks("Next question") }),
        ],
      };

      await provider.refreshCatalog();
      const opened = service.stream(request);
      promptMode = "leading-only";
      maxOutputTokens = 400;
      await provider.refreshCatalog();

      await Array.fromAsync(opened);
      expect((await opened.result()).stopReason).toBe("stop");
      const current = service.stream(request);
      await Array.fromAsync(current);
      expect((await current.result()).stopReason).toBe("stop");

      const wireText = (role: string, text: string) => ({
        role,
        content: [{ type: "text", text }],
      });
      expect(requests[0]).toMatchObject({
        max_tokens: 200,
        system: "Base\n\nOriginal",
        messages: [
          wireText("user", "First question"),
          wireText("system", "Base\n\nUpdated"),
          wireText("assistant", "First answer"),
          wireText("user", "Next question"),
        ],
      });
      expect(requests[1]).toMatchObject({
        max_tokens: 400,
        system: "Base\n\nUpdated",
        messages: [
          wireText("user", "First question"),
          wireText("assistant", "First answer"),
          wireText("user", "Next question"),
        ],
      });
    } finally {
      root.dispose();
    }
  } finally {
    await modules.close();
  }
});
