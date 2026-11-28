import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("keeps the partial assistant message readable while chat is forwarding model chunks", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, chat, di, llm, models, mock] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/chat-session/src/index.ts")>(
        "/packages/chat-session/src/index.ts",
      ),
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
      modules.load<typeof import("../../packages/mock-llm/src/index.ts")>(
        "/packages/mock-llm/src/index.ts",
      ),
    ]);
    const { SessionManager } = await modules.load<
      typeof import("../../packages/session-manager/src/index.ts")
    >("/packages/session-manager/src/index.ts");
    const scope = web.createServerScope();
    const gate = new mock.MockGate();
    try {
      const provider = scope.get(models.ProviderManager).create({ id: "mock" });
      provider.provide(
        llm.LlmProvider,
        di.createDescriptor(mock.ScriptedMockLlmProvider, async (ctx) => {
          ctx.text("first");
          await ctx.flush();
          await gate.wait(ctx.signal);
          return " second";
        }),
      );

      const sessionId = "stream-hook";

      const session = scope.get(SessionManager).acquire(sessionId).get(chat.ChatSession);
      session.pending.items.push(
          llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "Go" })] }),
        );
      const events = session.stream({ modelId: "mock" })[Symbol.asyncIterator]();
      try {
        expect((await events.next()).value).toMatchObject({ type: "message" });
        expect(await events.next()).toEqual({
          done: false,
          value: { type: "chunk", chunk: { type: "text_delta", delta: "first" } },
        });
        await gate.arrived;
        const page = await session.loadMessages();
        const partial = page.messages
          .map((message) => llm.Message.deserialize(message))
          .find((message) => message instanceof llm.AssistantMessage);
        expect(partial && llm.extractText(partial.content)).toBe("first");

        gate.release();
        expect(await events.next()).toEqual({
          done: false,
          value: { type: "chunk", chunk: { type: "text_delta", delta: " second" } },
        });
        expect((await events.next()).value).toMatchObject({ type: "message" });
        expect((await events.next()).done).toBe(true);
      } finally {
        session.abort();
        gate.release();
        while (!(await events.next()).done) {
          // Let the run settle before disposing the server scope.
        }
      }
    } finally {
      scope.dispose();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
