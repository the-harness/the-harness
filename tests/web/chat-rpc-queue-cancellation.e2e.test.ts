import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("skips canceled chat RPCs waiting behind an admitted call", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, chat, transport] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/chat-session/src/index.ts")>(
        "/packages/chat-session/src/index.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
    ]);
    const { SessionManager } = await modules.load<
      typeof import("../../packages/session-manager/src/index.ts")
    >("/packages/session-manager/src/index.ts");
    const root = web.createServerScope();
    const started = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    try {
      const sessionId = "queued-chat-rpc";
      const sessionScope = [sessionId];
      const session = root.get(SessionManager).acquire(sessionId).get(chat.ChatSession);
      const acknowledge = session.acknowledgeStatus.bind(session);
      const acknowledged = vi
        .spyOn(session, "acknowledgeStatus")
        .mockImplementationOnce(async () => {
          started.resolve();
          await complete.promise;
          return acknowledge();
        });
      const rpcServer = serverCalls(root.get(transport.ServerTransport));
      const call = (signal: AbortSignal) =>
        rpcServer.handleCall("chat.acknowledgeStatus", sessionScope, undefined, signal);

      const admitted = new AbortController();
      const first = call(admitted.signal);
      await started.promise;

      const waiting = new AbortController();
      const outcomes = Promise.allSettled([first, call(waiting.signal), call(waiting.signal)]);
      admitted.abort();
      waiting.abort();
      complete.resolve();

      expect(await outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: waiting.signal.reason },
        { status: "rejected", reason: waiting.signal.reason },
      ]);
      expect(acknowledged).toHaveBeenCalledOnce();

      await call(new AbortController().signal);
      expect(acknowledged).toHaveBeenCalledTimes(2);
    } finally {
      complete.resolve();
      root.dispose();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
