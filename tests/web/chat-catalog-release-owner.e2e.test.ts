import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

it("releases only the scopes of the sessions removed from the catalog", async () => {
  const modules = await createHarnessModules();
  vi.stubEnv("HARNESS_CHAT_DB", ":memory:");
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, chat, transport, sessions, sqlite] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/chat-session/src/index.ts")>(
        "/packages/chat-session/src/index.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      modules.load<typeof import("../../packages/session-manager/src/index.ts")>(
        "/packages/session-manager/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    const root = web.createServerScope();
    const database = root.get(sqlite.SqliteService);
    try {
      const server = serverCalls(root.get(transport.ServerTransport));
      const manager = root.get(sessions.SessionManager);
      const create = (id: string) =>
        server.handleCall("sessions.create", [], { id, workspaceId: "default" });
      const remove = (id: string) => server.handleCall("sessions.remove", [], { id });
      const draft = (id: string) => {
        manager.acquire(id).get(chat.ChatSession);
        return manager.get(id)!;
      };

      await create("first");
      const first = draft("first");
      let nested: Promise<unknown> | undefined;
      first.onDispose(() => {
        nested = create("added-during-release");
      });
      await remove("first");
      await nested;
      expect(first.isDisposed).toBe(true);
      const added = draft("added-during-release");
      expect(added.isDisposed).toBe(false);
      await remove("added-during-release");
      expect(added.isDisposed).toBe(true);
      expect(manager.get("added-during-release")).toBeUndefined();

      await Promise.all(["trigger", "kept", "renewed"].map(create));
      const trigger = draft("trigger");
      const kept = draft("kept");
      const renewed = draft("renewed");
      let replacement: typeof renewed | undefined;
      trigger.onDispose(() => {
        manager.release("renewed");
        manager.acquire("renewed").get(chat.ChatSession);
        replacement = manager.get("renewed");
      });
      await remove("trigger");
      expect(kept.isDisposed).toBe(false);
      expect(renewed.isDisposed).toBe(true);
      expect(replacement).toBeDefined();
      expect(manager.get("renewed")).toBe(replacement);

      await remove("renewed");
      await remove("kept");
      expect(kept.isDisposed).toBe(true);
      expect(replacement?.isDisposed).toBe(true);
      await database.flush();
      expect(database.read("SELECT id FROM session_catalog")).toEqual([]);
    } finally {
      root.dispose();
      await database.close();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
  }
});
