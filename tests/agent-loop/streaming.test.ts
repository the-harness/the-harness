import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "../../packages/tool-call/node_modules/zod/index.js";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LinkedTreeModule = typeof import("../../packages/linked-tree/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type MockLlmModule = typeof import("../../packages/mock-llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type ModelSelectionModule = typeof import("../../packages/model-selection/src/index.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let contextModule: ContextModule;
let di: DiModule;
let linkedTree: LinkedTreeModule;
let llm: LlmModule;
let mockLlm: MockLlmModule;
let modelProvider: ModelProviderModule;
let modelSelection: ModelSelectionModule;
let sqlite: SqliteModule;
let toolCallModule: ToolCallModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [
    agentLoop,
    contextModule,
    di,
    linkedTree,
    llm,
    mockLlm,
    modelProvider,
    modelSelection,
    sqlite,
    toolCallModule,
  ] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LinkedTreeModule>("/packages/linked-tree/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<MockLlmModule>("/packages/mock-llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<ModelSelectionModule>("/packages/model-selection/src/index.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
    harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createScope() {
  const root = di.createRootScope();
  root.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: "streaming" }),
    modelProvider.ProviderManager,
    llm.LlmService,
    di.createDescriptor(modelSelection.ModelSelectionService, {
      provider: "mock",
      model: "mock-model",
    }),
    toolCallModule.ToolCallService,
    agentLoop.AgentLoop,
  ]);
  const providerScope = root.get(modelProvider.ProviderManager).create({ id: "mock" });
  providerScope.provide(
    llm.LlmProvider,
    di.createDescriptor(mockLlm.ScriptedMockLlmProvider, {
      provider: "mock",
      models: [{ id: "mock-model", name: "Mock", provider: "mock" }],
      chunkSize: 1,
    }),
  );
  return {
    root,
    context: root.get(contextModule.Context),
    loop: root.get(agentLoop.AgentLoop),
    mock: providerScope.get(llm.LlmProvider) as InstanceType<
      MockLlmModule["ScriptedMockLlmProvider"]
    >,
  };
}

function user(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

function pendingText(context: InstanceType<ContextModule["Context"]>): string[] {
  return context.pending
    .filter((message) => message instanceof llm.AssistantMessage)
    .map((message) => llm.extractText(message.content));
}

describe("agent loop streaming", () => {
  it("updates the pending assistant message for each streamed chunk and applies streamChunk overrides", async () => {
    const opened = createScope();
    try {
      const snapshots: string[] = [];
      opened.root.run(() =>
        opened.loop.hooks.streamChunk.use(async (chunk, next) => {
          const rewritten =
            chunk.type === "text_delta" ? { ...chunk, delta: chunk.delta.toUpperCase() } : chunk;
          await next(rewritten);
          if (chunk.type === "text_delta") snapshots.push(pendingText(opened.context).join(""));
        }),
      );
      opened.mock.enqueue({ text: "abc" });
      opened.context.pending.push(user("go"));

      expect(await opened.loop.run()).toBe("completed");
      expect(snapshots).toEqual(["A", "AB", "ABC"]);
      expect(pendingText(opened.context)).toEqual(["abc"]);
      expect(opened.context.pending.filter((m) => m instanceof llm.UserMessage)).toHaveLength(0);
      expect(opened.mock.requests).toHaveLength(1);
      expect(
        opened.mock.requests[0]!.request.messages.map((message) =>
          llm.extractText(message.content),
        ),
      ).toEqual(["go"]);
    } finally {
      opened.root.dispose();
    }
  });

  it("returns a tool validation failure alongside successful sibling calls", async () => {
    const opened = createScope();
    const calls: string[] = [];
    class ScopedToolCalls extends toolCallModule.ToolCallService {
      protected override executeOne(
        call: InstanceType<LlmModule["ToolCallBlock"]>,
        signal: AbortSignal,
      ) {
        if (call.id === "dispatch-failed") throw new Error("dispatch failed");
        return super.executeOne(call, signal);
      }
    }
    try {
      opened.root.provide(toolCallModule.ToolCallService, ScopedToolCalls);
      const tools = opened.root.get(toolCallModule.ToolCallService);
      opened.root.run(() => {
        toolCallModule.useToolCall();
        tools.useTool(toolCallModule.functionTool({
          name: "unavailable",
          description: "Check an external resource before running",
          parameters: z.object({}).refine(() => {
            throw new Error("resource unavailable");
          }),
          execute: () => {
            calls.push("unavailable");
            return "unexpected";
          },
        }));
        tools.useTool(toolCallModule.functionTool({
          name: "ready",
          description: "Return the current status",
          parameters: z.object({}),
          execute: () => {
            calls.push("ready");
            return "ready";
          },
        }));
      });
      opened.mock.enqueue(
        {
          toolCalls: [
            { id: "failed", name: "unavailable", arguments: {} },
            { id: "dispatch-failed", name: "ready", arguments: {} },
            { id: "succeeded", name: "ready", arguments: {} },
          ],
        },
        "done",
      );
      opened.context.pending.push(user("Check both tools"));

      await expect(opened.loop.run()).resolves.toBe("completed");
      expect(calls).toEqual(["ready"]);
      expect(opened.mock.requests).toHaveLength(2);

      const results = opened.mock.requests[1]!.request.messages.filter(
        (message) => message instanceof llm.ToolResultMessage,
      );
      expect(
        results.map(({ toolCallId, isError, content }) => ({
          id: toolCallId,
          isError,
          text: llm.extractText(content),
        })),
      ).toEqual([
        { id: "failed", isError: true, text: "resource unavailable" },
        { id: "dispatch-failed", isError: true, text: "dispatch failed" },
        { id: "succeeded", isError: false, text: "ready" },
      ]);
    } finally {
      opened.root.dispose();
    }
  });

  it("composes scoped mock middleware around the scripted reply", async () => {
    const opened = createScope();
    const middlewareScope = opened.root.createChild();
    try {
      middlewareScope.run(() => {
        opened.mock.use(async (context, next) => {
          context.text("outer ");
          await next();
          return " outer";
        });
        opened.mock.use(async (context, next) => {
          context.text("inner ");
          await next();
          return " inner";
        });
      });
      const stream = () =>
        opened.mock
          .stream({ provider: "mock", model: "mock-model", messages: [user("go")] })
          .result();
      opened.mock.enqueue("reply", "next");
      const first = stream();
      middlewareScope.dispose();
      expect(llm.extractText((await first).message.content)).toBe("outer inner reply inner outer");
      expect(llm.extractText((await stream()).message.content)).toBe("next");
    } finally {
      opened.root.dispose();
    }
  });

  it("closes a provider stream that delivers a late chunk after cancellation", async () => {
    const opened = createScope();
    const reading = Promise.withResolvers<void>();
    const deliver = Promise.withResolvers<void>();
    const published: string[] = [];
    let closed = false;
    let resultReads = 0;
    const models = opened.mock.models;
    class LateProvider extends llm.LlmProvider {
      readonly models = models;

      override stream() {
        return {
          async *[Symbol.asyncIterator]() {
            try {
              reading.resolve();
              await deliver.promise;
              yield { type: "text_delta", delta: "late" } as const;
            } finally {
              closed = true;
            }
          },
          async result(): Promise<never> {
            resultReads += 1;
            throw new Error("No final response for the canceled stream");
          },
        };
      }
    }

    let running: ReturnType<typeof opened.loop.run> | undefined;
    try {
      const manager = opened.root.get(modelProvider.ProviderManager);
      manager.providers.get("mock")!.provide(llm.LlmProvider, LateProvider);
      opened.root.run(() =>
        opened.loop.hooks.streamChunk.use((chunk, next) => {
          if (chunk.type === "text_delta") published.push(chunk.delta);
          return next();
        }),
      );

      const input = user("Cancel while reading");
      opened.context.pending.push(input);
      running = opened.loop.run();
      const readingStarted = await Promise.race([
        reading.promise.then(() => true),
        running.then(() => false),
      ]);
      expect(readingStarted).toBe(true);
      opened.loop.abort();
      deliver.resolve();

      expect(await running).toBe("aborted");
      expect(closed).toBe(true);
      expect(published).toEqual([]);
      expect(resultReads).toBe(0);
      expect(pendingText(opened.context)).toEqual([]);
      expect(opened.context.pending.map(({ id }) => id)).toContain(input.id);
      expect(opened.context.batchCount).toBe(0);
    } finally {
      deliver.resolve();
      await running?.catch(() => {});
      opened.root.dispose();
    }
  });

  it("skips model dispatch when reading the transformed payload cancels the run", async () => {
    const opened = createScope();
    const transforming = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let running: ReturnType<typeof opened.loop.run> | undefined;
    try {
      opened.root.run(() =>
        opened.loop.hooks.transformContext.use(async (_input, next) => {
          const payload = await next();
          transforming.resolve();
          await resume.promise;
          return {
            ...payload,
            get messages() {
              opened.loop.abort();
              return payload.messages;
            },
          };
        }),
      );
      const input = user("Cancel during model request preparation");
      opened.context.pending.push(input);
      running = opened.loop.run();
      const entered = await Promise.race([
        transforming.promise.then(() => true),
        running.then(() => false),
      ]);
      expect(entered).toBe(true);
      resume.resolve();

      expect(await running).toBe("aborted");
      expect(opened.mock.requests).toHaveLength(0);
      expect(opened.context.pending.map(({ id }) => id)).toContain(input.id);
      expect(opened.context.batchCount).toBe(0);
    } finally {
      resume.resolve();
      await running?.catch(() => {});
      opened.root.dispose();
    }
  });

  it("removes the partial assistant message and restores the user input when aborted mid-stream", async () => {
    const opened = createScope();
    try {
      let aborted = false;
      opened.root.run(() =>
        opened.loop.hooks.streamChunk.use(async (_chunk, next) => {
          await next();
          if (!aborted) {
            aborted = true;
            opened.loop.abort();
          }
        }),
      );
      opened.mock.enqueue({ text: "abcdef" });
      opened.context.pending.push(user("cancel me"));

      expect(await opened.loop.run()).toBe("aborted");
      expect(aborted).toBe(true);
      expect(pendingText(opened.context)).toEqual([]);
      expect(
        opened.context.pending
          .filter((message) => message instanceof llm.UserMessage)
          .map((message) => llm.extractText(message.content)),
      ).toEqual(["cancel me"]);
      expect(opened.context.batchCount).toBe(0);
    } finally {
      opened.root.dispose();
    }
  });
});
