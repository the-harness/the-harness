import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { serverCalls } from "../helpers/server-calls.ts";

describe("chat.loadMessages", () => {
  it("restores user and assistant message variants from a reopened transcript", async () => {
    const modules = await createHarnessModules();
    const dir = mkdtempSync(join(tmpdir(), "harness-chat-load-"));
    const dbPath = join(dir, "chat.db");
    vi.stubEnv("HARNESS_CHAT_DB", dbPath);
    vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
    try {
      const [web, di, sqlite, tree, context, llm, transport] = await Promise.all([
        modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
          "/apps/web/src/server/scope.ts",
        ),
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
        modules.load<typeof import("../../packages/linked-tree/src/index.ts")>(
          "/packages/linked-tree/src/index.ts",
        ),
        modules.load<typeof import("../../packages/context/src/index.ts")>(
          "/packages/context/src/index.ts",
        ),
        modules.load<typeof import("../../packages/llm/src/index.ts")>(
          "/packages/llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      ]);

      const sessionId = "test-session-1";
      const seed = di.createRootScope({ id: "seed" });
      seed.provideAll([
        di.createDescriptor(sqlite.SqliteService, { path: dbPath }),
        tree.LinkedTree,
        di.createDescriptor(context.Context, { id: sessionId }),
      ]);
      const sqliteWriter = seed.get(sqlite.SqliteService);
      try {
        const ctx = seed.get(context.Context);
        ctx.pending.push(
          llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hello" })] }),
          llm.AssistantMessage.create({ content: [llm.TextBlock.create({ text: "hi there" })] }),
        );
        ctx.batch();
      } finally {
        seed.dispose();
        await sqliteWriter.close();
      }

      const restored = web.createServerScope();
      const sqliteReader = restored.get(sqlite.SqliteService);
      const { SessionManager } = await modules.load<
        typeof import("../../packages/session-manager/src/index.ts")
      >("/packages/session-manager/src/index.ts");
      try {
        restored.get(SessionManager).acquire(sessionId);
        const page = (await serverCalls(restored.get(transport.ServerTransport))
          .handleCall("chat.loadMessages", [sessionId], {
            limit: 30,
          })) as import("../../packages/ui-chat/src/types.ts").ChatMessagesPage;
        const messages = page.messages.map((message) => llm.Message.deserialize(message));

        expect(messages).toHaveLength(2);
        expect(messages[0]).toBeInstanceOf(llm.UserMessage);
        expect(messages[1]).toBeInstanceOf(llm.AssistantMessage);
        expect(
          messages
            .filter((message) => message instanceof llm.ContentMessage)
            .map((message) => llm.extractText(message.content)),
        ).toEqual(["hello", "hi there"]);
        expect(page.hasMore).toBe(false);
      } finally {
        restored.dispose();
        await sqliteReader.close();
      }
    } finally {
      vi.unstubAllEnvs();
      await modules.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
