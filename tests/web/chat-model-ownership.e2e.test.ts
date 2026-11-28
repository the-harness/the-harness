import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("keeps the running model when another client picks a different one", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, chat, di, llm, models, mock, transport] = await Promise.all([
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
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
    ]);
    const { SessionManager } = await modules.load<
      typeof import("../../packages/session-manager/src/index.ts")
    >("/packages/session-manager/src/index.ts");
    const scope = web.createServerScope();
    const gate = new mock.MockGate();
    try {
      scope
        .get(models.ProviderManager)
        .create({ id: "mock" })
        .provide(
          llm.LlmProvider,
          di.createDescriptor(mock.ScriptedMockLlmProvider, {
            models: [{ id: "first-model" }, { id: "second-model" }],
            handler: async (ctx) => {
              ctx.text(ctx.request.model);
              await ctx.flush();
              if (ctx.callIndex === 0) await gate.wait(ctx.signal);
            },
          }),
        );
      const rpcServer = serverCalls(scope.get(transport.ServerTransport));
      const streamServer = serverCalls(scope.get(transport.ServerTransport));
      const sessionId = "model-ownership";
      const session = scope.get(SessionManager).acquire(sessionId).get(chat.ChatSession);
      const sessionScope = [sessionId];
      const enqueue = (text: string) =>
        session.pending.items.push(
            llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] }),
          );
      const start = async (modelId: string) => {
        await rpcServer.handleCall("chat.start", sessionScope, { modelId });
        return streamServer
          .handleStream("/stream/chat.attachStream", sessionScope, undefined)
          [Symbol.asyncIterator]();
      };
      const nextOutput = async (events: AsyncIterator<unknown>) => {
        for (let next = await events.next(); ; next = await events.next()) {
          if (next.done || (next.value as { type: string }).type !== "message") return next;
        }
      };

      enqueue("Start the run");
      let events = await start("first-model");
      try {
        expect((await nextOutput(events)).value).toEqual(textChunk("first-model"));
        await gate.arrived;
        await rpcServer.handleCall("chat.start", sessionScope, { modelId: "second-model" });
        enqueue("Continue the run");
        gate.release();
        expect((await nextOutput(events)).value).toEqual(textChunk("first-model"));
        expect((await nextOutput(events)).done).toBe(true);

        enqueue("Start a different run");
        events = await start("second-model");
        expect((await nextOutput(events)).value).toEqual(textChunk("second-model"));
        expect((await nextOutput(events)).done).toBe(true);
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

function textChunk(delta: string) {
  return { type: "chunk", chunk: { type: "text_delta", delta } };
}
