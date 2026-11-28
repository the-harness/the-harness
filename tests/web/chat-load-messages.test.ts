import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../../packages/context/src/index.ts";
import { createDescriptor, createRootScope } from "../../packages/di/src/index.ts";
import { LinkedTree } from "../../packages/linked-tree/src/index.ts";
import { AssistantMessage, TextBlock, UserMessage } from "../../packages/llm/src/index.ts";
import { SqliteService } from "../../packages/sqlite/src/index.ts";
import { afterAll, describe, expect, it } from "vite-plus/test";

const tempDir = mkdtempSync(join(tmpdir(), "harness-chat-load-"));
const dbPath = join(tempDir, "chat.db");
process.env["HARNESS_CHAT_DB"] = dbPath;

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("chat.loadMessages", () => {
  it("loads persisted transcript messages through rpcServer", async () => {
    const sessionId = "test-session-1";

    const seedScope = createRootScope({ id: "seed" });
    seedScope.provideAll([createDescriptor(SqliteService, { path: dbPath }), LinkedTree]);
    seedScope.run(() => {
      const ctx = new Context({ id: sessionId });
      ctx.pending.push(
        UserMessage.create({ content: [TextBlock.create({ text: "hello" })] }),
        AssistantMessage.create({ content: [TextBlock.create({ text: "hi there" })] }),
      );
      ctx.batch();
    });

    const { rpcServer } = await import("../../apps/web/src/server/rpc.ts");
    const response = await rpcServer.handle(
      {
        id: "req-1",
        method: "chat.loadMessages",
        scope: ["session", sessionId],
        input: { limit: 30 },
      },
      {},
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      const page = response.result as {
        items: Array<{ role: string; text: string }>;
        nextBefore: number | null;
        hasMore: boolean;
      };
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ role: "user", text: "hello" });
      expect(page.items[1]).toMatchObject({ role: "assistant", text: "hi there" });
      expect(page.hasMore).toBe(false);
    }
  });
});
