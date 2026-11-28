import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("shares the running turn and the session's model with every web client viewing it", async () => {
  const modules = await createHarnessModules({
    aliases: [
      { find: /^reactivity$/, replacement: resolve(process.cwd(), "apps/web/src/reactivity.ts") },
      // The package entry pulls in .vue files.
      {
        find: /^@harness\/ui-sessions$/,
        replacement: resolve(process.cwd(), "packages/ui-sessions/src/sessions.ts"),
      },
      {
        find: /^@harness\/ui-menu$/,
        replacement: resolve(process.cwd(), "packages/ui-menu/src/menu.ts"),
      },
    ],
  });
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, di, llm, models, mock, gateway, rpc, stream, stateSync, transport, sqlite] =
      await Promise.all([
        modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
          "/apps/web/src/server/scope.ts",
        ),
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/llm/src/index.ts")>(
          "/packages/llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
          "/packages/model-provider/src/index.ts",
        ),
        modules.load<typeof import("../../packages/mock-llm/src/index.ts")>(
          "/packages/mock-llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/gateway/src/index.ts")>(
          "/packages/gateway/src/index.ts",
        ),
        modules.load<typeof import("../../packages/rpc/src/index.ts")>(
          "/packages/rpc/src/index.ts",
        ),
        modules.load<typeof import("../../packages/stream/src/index.ts")>(
          "/packages/stream/src/index.ts",
        ),
        modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
          "/packages/state-sync/src/index.ts",
        ),
        modules.load<typeof import("../../packages/transport/src/index.ts")>(
          "/packages/transport/src/index.ts",
        ),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
      ]);
    const [storage, sessions, chat] = await Promise.all([
      modules.load<typeof import("../../packages/ui-storage/src/index.ts")>(
        "/packages/ui-storage/src/index.ts",
      ),
      modules.load<typeof import("../../packages/ui-sessions/src/sessions.ts")>(
        "/packages/ui-sessions/src/sessions.ts",
      ),
      modules.load<typeof import("../../packages/ui-chat/src/chat.ts")>(
        "/packages/ui-chat/src/chat.ts",
      ),
    ]);

    const runtime = web.createServerScope();
    const database = runtime.get(sqlite.SqliteService);
    const server = createServer();
    const gate = new mock.MockGate();
    const clients: ReturnType<typeof di.createRootScope>[] = [];
    try {
      const provider = runtime.get(models.ProviderManager).create({ id: "mock" });
      provider.provide(
        llm.LlmProvider,
        di.createDescriptor(mock.ScriptedMockLlmProvider, {
          models: [{ id: "mock" }, { id: "other" }],
          handler: async (ctx) => {
            if (ctx.callIndex > 0) return `answered by ${ctx.request.model}`;
            ctx.text("first");
            await ctx.flush();
            await gate.wait(ctx.signal);
            return " second";
          },
        }),
      );
      gateway.attachGateway(server, async () => runtime.get(transport.ServerTransport) as never);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      vi.stubGlobal("location", {
        protocol: "http:",
        host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
      });

      // Each client owns its own WebSocket connection, like a separate browser.
      const connect = () => {
        const root = di.createRootScope();
        clients.push(root);
        root.provideAll([
          transport.WebTransportConnection,
          [transport.Transport, transport.WebTransport],
          rpc.RpcClientService,
          stream.StreamClientService,
          stateSync.StateSyncClientService,
          storage.UiStorageService,
          sessions.UiSessionsService,
        ]);
        return root;
      };
      const openChat = (root: ReturnType<typeof di.createRootScope>, sessionId: string) => {
        const scope = root.createChild();
        scope.provide(
          transport.Transport,
          root.get(transport.Transport).childScope(sessionId),
        );
        scope.provideAll([
          rpc.RpcClientService,
          stream.StreamClientService,
          stateSync.StateSyncClientService,
          di.createDescriptor(chat.UiChatService, sessionId),
        ]);
        const service = scope.get(chat.UiChatService);
        void service.messages.value;
        return service;
      };

      const owner = connect();
      const observer = connect();
      const sessionId = owner.get(sessions.UiSessionsService).newSession();
      for (const root of [owner, observer]) {
        await expect
          .poll(() => root.get(sessions.UiSessionsService).sessions.value.map(({ id }) => id))
          .toContain(sessionId);
      }

      const sender = openChat(owner, sessionId);
      const viewer = openChat(observer, sessionId);
      await sender.refreshChoices();
      sender.model.value = "mock";
      sender.draft.value = "Go";
      await sender.send();

      const assistant = (service: typeof viewer) =>
        service.messages.value.findLast((message) => message.role === "assistant");
      await gate.arrived;
      for (const service of [sender, viewer]) {
        await expect.poll(() => service.isRunning()).toBe(true);
        await expect
          .poll(() => service.messages.value.map(({ role, text }) => `${role}:${text}`))
          .toEqual(["user:Go", "assistant:first"]);
        expect(assistant(service)?.streaming).toBe(true);
      }

      gate.release();
      for (const service of [sender, viewer]) {
        await expect.poll(() => service.isRunning()).toBe(false);
        await expect
          .poll(() => service.messages.value.map(({ role, text }) => `${role}:${text}`))
          .toEqual(["user:Go", "assistant:first second"]);
        expect(assistant(service)?.streaming).toBeFalsy();
      }

      // The session's model is session state too: a switch on one client is what the next run uses.
      viewer.model.value = "other";
      await expect.poll(() => sender.model.value).toBe("other");
      sender.draft.value = "Again";
      await sender.send();
      for (const service of [sender, viewer]) {
        await expect.poll(() => assistant(service)?.text).toBe("answered by other");
      }
    } finally {
      gate.release();
      for (const root of clients) root.dispose();
      await new Promise<void>((done) => server.close(() => done()));
      runtime.dispose();
      await database.close();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await modules.close();
  }
});
