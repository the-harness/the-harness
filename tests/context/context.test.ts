import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type ContextModule = typeof import("../../packages/context/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type ReactivityModule = typeof import("reactivity");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");

let harness: HarnessModules;
let contextModule: ContextModule;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let llm: LlmModule;
let reactivity: ReactivityModule;
let sqlite: SqliteModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [contextModule, di, linkedTree, llm, reactivity, sqlite] = await Promise.all([
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<ReactivityModule>("/packages/llm/node_modules/reactivity/dist/index.js"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function message(id: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text: id })] });
}

function textOf(message: InstanceType<LlmModule["Message"]>): string {
  return llm.extractText((message as InstanceType<LlmModule["ContentMessage"]>).content);
}

function createContext(
  initialPending?: readonly InstanceType<LlmModule["Message"]>[],
  path = ":memory:",
  id = `context-${crypto.randomUUID()}`,
) {
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, {
      id,
      initialPending,
    }),
  ]);
  return { scope, context: scope.get(contextModule.Context) };
}

describe("context batches", () => {
  it("isolates historical batch edits across forks and database reopen", async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(join(artifacts, "context-fork-isolation-"));
    const path = join(directory, "context.db");
    const field = contextModule.BatchMeta.defineField<string, typeof contextModule.BatchMeta>(
      "test:context:fork-label",
    );
    const history = (context: InstanceType<ContextModule["Context"]>) =>
      Array.fromAsync(context.readBackward(), (batch) => ({
        messages: batch.messages.map(textOf),
        label: batch.meta.get(field),
      }));
    try {
      const { context, scope } = createContext([message("one")], path, "source");
      try {
        const first = context.batch();
        first.meta.set(field, "before fork");
        context.pending.push(message("two"), message("three"));
        const second = context.batch();
        context.pending.push(message("queued"));

        const instances = scope.get(di.InstantiationService);
        const copy = instances.createInstance(
          contextModule.Context,
          await context.fork({ id: "copy" }),
        );
        first.meta.set(field, "source");
        second.meta.set(field, "source tail");
        const [copyTail, copyFirst] = await Array.fromAsync(copy.readBackward());
        expect(copyFirst!.meta.get(field)).toBe("before fork");
        expect(copyTail!.meta.get(field)).toBeUndefined();
        copyFirst!.meta.set(field, "copy");
        copyTail!.meta.set(field, "copy tail");
        copy.pending.splice(0, 1, message("copy pending"));

        await copy.fork({ id: "cut", at: { batchIndex: 1, messageCount: 1 } });
        copy.unbatch();
        const replacement = copy.batch();
        copyTail!.meta.set(field, "detached");
        expect(replacement.meta.get(field)).toBeUndefined();
        copyFirst!.meta.set(field, "later");
        expect(await history(context)).toEqual([
          { messages: ["two", "three"], label: "source tail" },
          { messages: ["one"], label: "source" },
        ]);
      } finally {
        await scope.get(sqlite.SqliteService).close();
        scope.dispose();
      }

      const reader = createContext(undefined, path, "source");
      try {
        const instances = reader.scope.get(di.InstantiationService);
        const copy = instances.createInstance(contextModule.Context, { id: "copy" });
        const cut = instances.createInstance(contextModule.Context, { id: "cut" });
        expect(await history(reader.context)).toEqual([
          { messages: ["two", "three"], label: "source tail" },
          { messages: ["one"], label: "source" },
        ]);
        expect(reader.context.pending.map(textOf)).toEqual(["queued"]);
        expect(await history(copy)).toEqual([
          { messages: ["two", "three", "copy pending"], label: undefined },
          { messages: ["one"], label: "later" },
        ]);
        expect(await history(cut)).toEqual([
          { messages: ["two"], label: undefined },
          { messages: ["one"], label: "copy" },
        ]);
      } finally {
        await reader.scope.get(sqlite.SqliteService).close();
        reader.scope.dispose();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores nested message variants from batch metadata after reopening the database", async () => {
    const artifacts = join(process.cwd(), "temp", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(join(artifacts, "context-batch-meta-"));
    const path = join(directory, "context.db");
    const field = contextModule.BatchMeta.defineField<
      { readonly messages: readonly InstanceType<LlmModule["Message"]>[] },
      typeof contextModule.BatchMeta
    >("test:context:messages");
    try {
      const writer = createContext([message("first message")], path, "persisted");
      try {
        writer.context.batch().meta.set(field, { messages: [message("nested message")] });
      } finally {
        await writer.scope.get(sqlite.SqliteService).close();
        writer.scope.dispose();
      }
      const reader = createContext(undefined, path, "persisted");
      try {
        const batches = [];
        for await (const batch of reader.context.readBackward()) batches.push(batch);
        const nested = batches[0]?.meta.get(field)?.messages[0];
        expect(nested).toBeInstanceOf(llm.UserMessage);
        expect(textOf(nested!)).toBe("nested message");
      } finally {
        await reader.scope.get(sqlite.SqliteService).close();
        reader.scope.dispose();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["preparation", "commit", "multiple SQL statements"] as const)(
    "restores pending messages after a later write fails during %s",
    async (failure) => {
      const artifacts = join(process.cwd(), "temp", "artifacts");
      mkdirSync(artifacts, { recursive: true });
      const directory = mkdtempSync(join(artifacts, "context-batch-rollback-"));
      const path = join(directory, "context.db");
      const writer = createContext([message("keep")], path, "session");
      const database = writer.scope.get(sqlite.SqliteService);
      try {
        await database.flush();
        writer.context.batch();
        const flushed = database.flush();
        if (failure === "preparation") {
          expect(() =>
            database.write(() => {
              throw new Error("invalid snapshot");
            }),
          ).toThrow("invalid snapshot");
        } else if (failure === "multiple SQL statements") {
          database.write(() => [
            ["UPDATE tree_branches SET updated_at = 1; /* next */ DELETE FROM tree_branches"],
          ]);
        } else {
          database.write(() => [
            [
              "INSERT INTO tree_branches (id, state, updated_at) VALUES (?, ?, ?)",
              "session",
              "[]",
              0,
            ],
          ]);
        }
        await expect(flushed).rejects.toThrow();
        expect(() => database.write(() => [["DELETE FROM tree_branches"]])).toThrow();
        await expect(database.close()).rejects.toThrow();

        const reader = createContext(undefined, path, "session");
        try {
          expect(reader.context.batchCount).toBe(0);
          expect(reader.context.pending.map(textOf)).toEqual(["keep"]);
        } finally {
          await reader.scope.get(sqlite.SqliteService).close();
          reader.scope.dispose();
        }
      } finally {
        writer.scope.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { transition: "batch", pendingCount: 0, batchCount: 1 },
    { transition: "unbatch", pendingCount: 1, batchCount: 0 },
  ] as const)(
    "persists pending edits from a synchronous observer during $transition",
    async ({ transition, pendingCount, batchCount }) => {
      const artifacts = join(process.cwd(), "temp", "artifacts");
      mkdirSync(artifacts, { recursive: true });
      const directory = mkdtempSync(join(artifacts, "context-pending-observer-"));
      const path = join(directory, "context.db");
      try {
        const writer = createContext([message("original")], path, "persisted");
        try {
          if (transition === "unbatch") writer.context.batch();
          const observed = message("observed");
          const { pending } = writer.context;
          const stop = reactivity.watchSyncEffect(() => {
            if (pending.length === pendingCount) pending.splice(0, pendingCount, observed);
          });
          try {
            writer.context[transition]();
            expect(pending.map(textOf)).toEqual(["observed"]);
          } finally {
            stop();
          }
        } finally {
          await writer.scope.get(sqlite.SqliteService).close();
          writer.scope.dispose();
        }

        const reader = createContext(undefined, path, "persisted");
        try {
          expect(reader.context.batchCount).toBe(batchCount);
          expect(reader.context.pending.map(textOf)).toEqual(["observed"]);
        } finally {
          await reader.scope.get(sqlite.SqliteService).close();
          reader.scope.dispose();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("drops the claimed pending when the batch hook throws", () => {
    const { scope, context } = createContext([message("keep")]);
    try {
      scope.run(() =>
        context.hooks.batch.use(() => {
          throw new Error("batch hook failed");
        }),
      );

      expect(() => context.batch()).toThrow("batch hook failed");
      expect(context.batchCount).toBe(0);
      expect(context.pending).toEqual([]);
    } finally {
      scope.dispose();
    }
  });

  it("batches pending messages through the hook and reads them back newest first", async () => {
    const { scope, context } = createContext([message("m1"), message("m2")]);
    try {
      context.pending.push(message("m3"));

      const first = context.batch();
      expect(first.index).toBe(0);
      expect(first.messages.map(textOf)).toEqual(["m1", "m2", "m3"]);
      expect(context.pending).toEqual([]);
      expect(context.batchCount).toBe(1);

      context.pending.push(message("m4"));
      const second = context.batch();
      expect(second.index).toBe(1);
      expect(second.messages.map(textOf)).toEqual(["m4"]);

      const seen: number[] = [];
      for await (const batch of context.readBackward()) {
        seen.push(batch.index);
      }
      expect(seen).toEqual([1, 0]);
    } finally {
      scope.dispose();
    }
  });

  it("unbatches the last batch back to the front of pending and refuses to unbatch none", () => {
    const { scope, context } = createContext([message("m1")]);
    try {
      context.batch();
      context.pending.push(message("m2"));
      context.batch();
      context.pending.push(message("m3"));

      context.unbatch();
      expect(context.batchCount).toBe(1);
      expect(context.pending.map(textOf)).toEqual(["m2", "m3"]);

      context.unbatch();
      expect(context.batchCount).toBe(0);
      expect(context.pending.map(textOf)).toEqual(["m1", "m2", "m3"]);

      expect(() => context.unbatch()).toThrow("no committed batch to unbatch");
    } finally {
      scope.dispose();
    }
  });

  it("snapshots hook output so later pending and batch mutation cannot change stored batches", async () => {
    const { scope, context } = createContext();
    const owner = reactivity.effectScope();
    try {
      const seen: string[][] = [];
      owner.run(() =>
        context.hooks.batch.use((messages, next) => {
          seen.push(messages.map(textOf));
          return next(messages.filter((item) => textOf(item) !== "drop"));
        }),
      );

      context.pending.push(message("keep"), message("drop"));
      const batch = context.batch();
      expect(seen).toEqual([["keep", "drop"]]);
      expect(batch.messages.map(textOf)).toEqual(["keep"]);

      const fromRead = [];
      for await (const entry of context.readBackward()) fromRead.push(entry);
      (fromRead[0]!.messages as unknown as Array<InstanceType<LlmModule["Message"]>>).push(
        message("late"),
      );
      const nextBatch = context.batch();
      expect(nextBatch.index).toBe(1);
      expect(nextBatch.messages).toEqual([]);

      const again = [];
      for await (const entry of context.readBackward()) again.push(entry);
      expect(again[1]!.index).toBe(0);
      expect(again[1]!.messages.map(textOf)).toEqual(["keep"]);
    } finally {
      owner.stop();
      scope.dispose();
    }
  });

  it("tracks pending mutations through the shallow reactive array", () => {
    const { scope, context } = createContext();
    try {
      const lengths: number[] = [];
      const stop = reactivity.watchSyncEffect(() => {
        lengths.push(context.pending.length);
      });

      context.pending.push(message("a"));
      context.pending.push(message("b"));
      context.pending.splice(0, 1);
      context.pending[0] = message("c");
      stop();
      context.pending.push(message("d"));

      expect(lengths).toEqual([0, 1, 2, 1]);
      expect(context.pending.map(textOf)).toEqual(["c", "d"]);
    } finally {
      scope.dispose();
    }
  });
});
