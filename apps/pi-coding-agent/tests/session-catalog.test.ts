import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vite-plus/test";
import { Context } from "@harness/context";
import { createDescriptor, createRootScope } from "@harness/di";
import { LinkedTree } from "@harness/linked-tree";
import { AssistantMessage, SystemMessage, TextBlock, UserMessage } from "@harness/llm";
import { SqliteService } from "@harness/sqlite";
import { createSessionCatalog, initializeSessionCatalog } from "../src/session-catalog.ts";

it("counts pi message entries and reads a session's forked branch", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-session-catalog-"));
  const database = join(dir, "sessions", "harness.sqlite");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const root = createRootScope();
  root.provideAll([LinkedTree, createDescriptor(SqliteService, { path: database })]);
  const sqlite = root.get(SqliteService);
  initializeSessionCatalog(sqlite, database);
  const catalog = createSessionCatalog(root, database);
  const scope = root.createChild();
  try {
    await catalog.remember({
      id: "session", cwd: dir, createdAt: Date.now(), provider: "fake", model: "fake-model",
    });
    const section = (id: string) => SystemMessage.create({
      sectionId: id,
      content: [TextBlock.create({ text: `${id} prompt` })],
    });
    scope.provide(createDescriptor(Context, {
      id: "branch",
      initialPending: [
        section("base"), section("tools"), section("environment"), section("agents"), section("skills"),
        UserMessage.create({ content: [TextBlock.create({ text: "MSG-A first" })] }),
      ],
    }));
    const context = scope.get(Context);
    context.batch();
    context.pending.push(AssistantMessage.create({
      provider: "fake", model: "fake-model", content: [TextBlock.create({ text: "REPLY-A" })],
    }));
    await sqlite.flush();
    await catalog.saveTree("session", {
      branchId: "branch", leafId: null, entries: [], nativeToPi: [], checkpoints: [], importedEntryIds: [],
    });

    const [info] = await catalog.list(dir);
    expect(info).toMatchObject({
      firstMessage: "MSG-A first",
      messageCount: 3,
      path: `${resolve(database)}#session`,
    });
  } finally {
    scope.dispose();
    root.dispose();
    await sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
