import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("cancels the DeepSeek response body when a caller stops consuming model chunks", async () => {
  const harness = await createHarnessModules();
  try {
    const [deepseek, di, llm, mock, providers] = await Promise.all([
      harness.load<typeof import("../../packages/deepseek/src/index.ts")>(
        "/packages/deepseek/src/index.ts",
      ),
      harness.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      harness.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      harness.load<typeof import("../../packages/mock-llm/src/index.ts")>(
        "/packages/mock-llm/src/index.ts",
      ),
      harness.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
    ]);
    const root = di.createRootScope();
    root.provideAll([providers.ProviderManager, llm.LlmService]);
    let canceled = false;
    const payload = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "Partial reply" },
            })}\n\n`,
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    try {
      const provider = root.get(providers.ProviderManager).create({ id: "deepseek" });
      const inner = di.createDescriptor(deepseek.DeepSeekLlmProvider, {
        fetch: async () =>
          new Response(payload, { headers: { "content-type": "text/event-stream" } }),
      });
      const recording = new mock.LlmRecording();
      provider.provide(di.createDescriptor(mock.RecordingLlmProvider, inner, { recording }));
      const stream = root.get(llm.LlmService).stream({
        provider: "deepseek",
        model: "deepseek-flash",
        messages: [llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "Hello" })] })],
      });

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        break;
      }
      expect(chunks).toEqual([{ type: "text_delta", delta: "Partial reply" }]);
      await expect.poll(() => canceled).toBe(true);
      await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
      expect(recording.entries).toMatchObject([
        {
          stopReason: "aborted",
          chunks: [{ chunk: { type: "text_delta", delta: "Partial reply" } }],
        },
      ]);
    } finally {
      root.dispose();
    }
  } finally {
    await harness.close();
  }
});
