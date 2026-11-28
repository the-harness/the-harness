import { expect, it } from "vite-plus/test";
import type { LlmRequest } from "../../packages/llm/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("replays DeepSeek thinking signatures only to their original provider and model", async () => {
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
      const thinking = { type: "thinking", thinking: "Signed reasoning" };
      const signed = { ...thinking, signature: "fixture-signature" };
      const unsigned = { type: "thinking", thinking: "Unsigned reasoning" };
      const events = [
        { type: "content_block_start", index: 0, content_block: signed },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: unsigned },
        { type: "content_block_stop", index: 1 },
        { type: "message_stop" },
      ];
      const sseBody = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const requests: Array<{
        provider: string;
        model: string;
        messages: readonly { role: string; content: unknown }[];
      }> = [];
      for (const id of ["source", "destination"]) {
        root.setup(() =>
          deepseek.useDeepSeekProvider({
            id,
            baseUrl: `https://${id}.invalid`,
            apiKey: "",
            models: [{ id: "shared" }, { id: "alternate" }],
            fetch: async (input, init) => {
              const request = new Request(input, init);
              expect(request.url).toBe(`https://${id}.invalid/anthropic/v1/messages`);
              requests.push({ ...(await request.json()), provider: id });
              return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
            },
          }),
        );
      }

      const service = root.get(llm.LlmService);
      const run = async (request: LlmRequest) => {
        const stream = service.stream(request);
        await Array.fromAsync(stream);
        const response = await stream.result();
        expect(response.stopReason).toBe("stop");
        return response.message;
      };
      const first = llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "First" })] });
      const reply = await run({ provider: "source", model: "shared", messages: [first] });
      expect(reply).toMatchObject({ provider: "source", model: "shared" });
      const next = llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "Next" })] });
      const messages = [first, reply, next];
      await run({ provider: "source", model: "shared", messages });
      await run({ provider: "destination", model: "shared", messages });
      await run({ provider: "source", model: "alternate", messages });

      const assistantContent = (index: number) =>
        requests[index]?.messages.find(({ role }) => role === "assistant")?.content;
      expect(requests.map(({ provider, model }) => [provider, model])).toEqual([
        ["source", "shared"],
        ["source", "shared"],
        ["destination", "shared"],
        ["source", "alternate"],
      ]);
      expect(assistantContent(1)).toEqual([signed, unsigned]);
      expect(assistantContent(2)).toEqual([thinking, unsigned]);
      expect(assistantContent(3)).toEqual([thinking, unsigned]);
    } finally {
      root.dispose();
    }
  } finally {
    await modules.close();
  }
});
