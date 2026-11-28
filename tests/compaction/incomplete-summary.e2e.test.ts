import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type { MockStep } from "../../packages/mock-llm/src/index.ts";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("keeps the durable compaction slice until the provider completes a new summary", async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "incomplete-compaction-"));
  const path = join(directory, "history.db");
  const modules = await createHarnessModules();
  try {
    const [compaction, context, size, di, llm, tree, mock, provider, selection, sqlite] =
      await Promise.all([
        modules.load<typeof import("../../packages/pi-compaction/src/index.ts")>(
          "/packages/pi-compaction/src/index.ts",
        ),
        modules.load<typeof import("../../packages/context/src/index.ts")>(
          "/packages/context/src/index.ts",
        ),
        modules.load<typeof import("../../packages/context-size/src/index.ts")>(
          "/packages/context-size/src/index.ts",
        ),
        modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
        modules.load<typeof import("../../packages/llm/src/index.ts")>(
          "/packages/llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/linked-tree/src/index.ts")>(
          "/packages/linked-tree/src/index.ts",
        ),
        modules.load<typeof import("../../packages/mock-llm/src/index.ts")>(
          "/packages/mock-llm/src/index.ts",
        ),
        modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
          "/packages/model-provider/src/index.ts",
        ),
        modules.load<typeof import("../../packages/model-selection/src/index.ts")>(
          "/packages/model-selection/src/index.ts",
        ),
        modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
          "/packages/sqlite/src/index.ts",
        ),
      ]);

    function open(id: string, ...steps: MockStep[]) {
      const scope = di.createRootScope();
      scope.provideAll([
        di.createDescriptor(sqlite.SqliteService, { path }),
        tree.LinkedTree,
        provider.ProviderManager,
        llm.LlmService,
        size.ContextSizeService,
        di.createDescriptor(selection.ModelSelectionService, { provider: "mock", model: "mock" }),
        di.createDescriptor(context.Context, { id }),
        compaction.PiCompactionService,
      ]);
      const modelScope = scope.get(provider.ProviderManager).create({ id: "mock" });
      modelScope.provide(llm.LlmProvider, mock.ScriptedMockLlmProvider);
      const model = modelScope.get(llm.LlmProvider) as InstanceType<
        typeof mock.ScriptedMockLlmProvider
      >;
      model.enqueue(...steps);

      return {
        scope,
        context: scope.get(context.Context),
        compaction: scope.get(compaction.PiCompactionService),
        requests: model.requests,
        async close() {
          const database = scope.get(sqlite.SqliteService);
          scope.dispose();
          await database.close();
        },
      };
    }

    const user = (text: string) =>
      llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
    const writer = open("chat");
    try {
      writer.context.pending.push(user("earlier conversation"));
      writer.context.batch().meta.set(compaction.CompactionSliceField, {
        from: 0,
        to: 0,
        systemMessages: [],
        messages: [
          compaction.CompactionSummaryMessage.create({
            from: 0,
            to: 0,
            content: [llm.TextBlock.create({ text: "durable earlier summary" })],
          }),
        ],
      });
      writer.context.pending.push(user("unsummarized conversation"));
      writer.context.batch();
      await writer.context.fork({ id: "sibling" });
    } finally {
      await writer.close();
    }

    const incomplete = [
      { text: "provider failed", stopReason: "error", error: { message: "provider failed" } },
      { text: "canceled summary", stopReason: "aborted" },
      { text: "truncated summary", stopReason: "max_tokens" },
      { text: "unfinished tool request", stopReason: "tool_calls" },
      { text: " \n ", stopReason: "stop" },
    ] satisfies MockStep[];
    const failing = open("chat", ...incomplete);
    try {
      for (const { stopReason } of incomplete) {
        expect(await failing.compaction.compact(1), `stop reason: ${stopReason}`).toBeUndefined();
      }
      expect(failing.requests).toHaveLength(incomplete.length);
      expect(await failing.compaction.latestSlice()).toMatchObject({ from: 0, to: 0 });
    } finally {
      await failing.close();
    }

    const summaryStarted = Promise.withResolvers<AbortSignal | undefined>();
    const releaseSummary = Promise.withResolvers<void>();
    const retired = open("chat", async (ctx) => {
      summaryStarted.resolve(ctx.signal);
      await releaseSummary.promise;
      return "late provider summary";
    });
    try {
      const pending = retired.compaction.compact(1);
      try {
        const signal = await summaryStarted.promise;
        // provide is idempotent for an equal registration; replacing the service takes unprovide.
        retired.scope.unprovide(compaction.PiCompactionService);
        retired.scope.provide(compaction.PiCompactionService);
        expect(signal?.aborted).toBe(true);
      } finally {
        releaseSummary.resolve();
        await pending;
      }
      expect(await pending).toBeUndefined();
      const current = retired.scope.get(compaction.PiCompactionService);
      expect(await current.latestSlice()).toMatchObject({ from: 0, to: 0 });

      const hookStarted = Promise.withResolvers<void>();
      const releaseHook = Promise.withResolvers<void>();
      retired.scope.run(() =>
        current.hooks.compact.use(async () => {
          hookStarted.resolve();
          await releaseHook.promise;
          return [user("late hook summary")];
        }),
      );
      const withHook = current.compact(1);
      try {
        await hookStarted.promise;
        // provide is idempotent for an equal registration; replacing the service takes unprovide.
        retired.scope.unprovide(compaction.PiCompactionService);
        retired.scope.provide(compaction.PiCompactionService);
      } finally {
        releaseHook.resolve();
        await withHook;
      }
      expect(await withHook).toBeUndefined();
      expect(await retired.scope.get(compaction.PiCompactionService).latestSlice()).toMatchObject({
        from: 0,
        to: 0,
      });
    } finally {
      await retired.close();
    }

    const retry = open("chat", "complete summary");
    try {
      expect(await retry.compaction.compact(1)).toMatchObject({ from: 0, to: 1 });
      expect(retry.requests).toHaveLength(1);
      const input = retry.requests[0]!.request.messages;
      expect(input[0]).toBeInstanceOf(compaction.CompactionSummaryMessage);
      expect(input.slice(0, 2)).toMatchObject([
        { content: [{ text: "durable earlier summary" }] },
        { content: [{ text: "unsummarized conversation" }] },
      ]);
    } finally {
      await retry.close();
    }

    const reader = open("chat");
    try {
      const saved = await reader.compaction.latestSlice();
      expect(saved).toMatchObject({ from: 0, to: 1 });
      const summary = saved?.messages[0];
      expect(summary).toBeInstanceOf(compaction.CompactionSummaryMessage);
      expect(summary).toMatchObject({
        content: [{ text: expect.stringContaining("complete summary") }],
      });
    } finally {
      await reader.close();
    }

    const sibling = open("sibling");
    try {
      expect(await sibling.compaction.latestSlice()).toMatchObject({
        from: 0,
        to: 0,
        messages: [{ content: [{ text: "durable earlier summary" }] }],
      });
    } finally {
      await sibling.close();
    }
  } finally {
    await modules.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
