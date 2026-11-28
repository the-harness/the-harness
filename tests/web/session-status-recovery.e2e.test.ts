import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("recovers saved status only when starting the Web runtime", async () => {
  const modules = await createHarnessModules();
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "session-status-recovery-"));
  vi.stubEnv("HARNESS_CHAT_DB", join(directory, "chat.db"));
  vi.stubEnv("HARNESS_SECRET_STORAGE_KEY_FILE", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  try {
    const [web, digests, status, statusNode, sqlite] = await Promise.all([
      modules.load<typeof import("../../apps/web/src/server/scope.ts")>(
        "/apps/web/src/server/scope.ts",
      ),
      modules.load<typeof import("../../packages/session-digest/src/node.ts")>(
        "/packages/session-digest/src/node.ts",
      ),
      modules.load<typeof import("../../packages/session-status/src/index.ts")>(
        "/packages/session-status/src/index.ts",
      ),
      modules.load<typeof import("../../packages/session-status/src/node.ts")>(
        "/packages/session-status/src/node.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    const sessionId = "recover-status";
    const writer = web.createServerScope();
    const writerDb = writer.get(sqlite.SqliteService);
    try {
      const store = writer.get(digests.SessionDigestStore);
      const digest = store.get(sessionId);
      const running = status.RunningSessionStatus.create({ step: "Thinking" });
      digest.set(status.sessionStatusField, running);
      await store.flush();

      const original = writer.get(statusNode.SessionStatusHostService);
      expect(original.active.items.get(sessionId)).toBe(running);
      class ReplacementStatusHost extends statusNode.SessionStatusHostService {}
      writer.provide(statusNode.SessionStatusHostService, ReplacementStatusHost);
      const replacement = writer.get(statusNode.SessionStatusHostService);
      expect(replacement).not.toBe(original);
      expect(replacement.active.items.get(sessionId)).toBe(running);
      expect(digest.get(status.sessionStatusField)).toBe(running);
    } finally {
      writer.dispose();
      await writerDb.close();
    }

    const reader = web.createServerScope();
    const readerDb = reader.get(sqlite.SqliteService);
    try {
      const restored = reader.get(statusNode.SessionStatusHostService).active.items.get(sessionId);
      expect(restored).toBeInstanceOf(status.FailedSessionStatus);
      expect(restored).toMatchObject({ message: "Interrupted" });
    } finally {
      reader.dispose();
      await readerDb.close();
    }
  } finally {
    vi.unstubAllEnvs();
    await modules.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
