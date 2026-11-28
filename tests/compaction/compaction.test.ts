import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { CompactionSummarizer } from "../../packages/pi-compaction/src/index.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";
import { errorResponse, providerConfig, textResponse } from "../helpers/llm-fixtures.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type CompactionModule = typeof import("../../packages/pi-compaction/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type ContextSizeModule = typeof import("../../packages/context-size/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let compactionModule: CompactionModule;
let contextModule: ContextModule;
let contextSize: ContextSizeModule;
let di: DiModule;
let llm: LlmModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [agentLoop, compactionModule, contextModule, contextSize, di, llm] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<CompactionModule>("/packages/pi-compaction/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<ContextSizeModule>("/packages/context-size/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function messageText(message: InstanceType<LlmModule["Message"]>): string {
  return llm.extractText((message as InstanceType<LlmModule["ContentMessage"]>).content);
}

function summary(from: number, to: number, text = "summary") {
  return compactionModule.CompactionSummaryMessage.create({
    from,
    to,
    content: [llm.TextBlock.create({ text })],
  });
}

interface ScopeOptions {
  readonly maxTokens?: number;
  readonly summarize?: CompactionSummarizer;
  readonly fetch?: typeof globalThis.fetch;
}

function createScope(options: ScopeOptions = {}) {
  return di.createRootScope({
    services: [
      [contextModule.Context, di.createDescriptor(contextModule.Context, { id: "compaction" })],
      [
        llm.LlmService,
        di.createDescriptor(llm.LlmService, {
          providers: [providerConfig()],
          defaultOptions: {
            fetch: options.fetch ?? textResponseFetch(),
            maxRetries: 0,
          },
        }),
      ],
      [contextSize.ContextSizeService, contextSize.ContextSizeService],
      [
        compactionModule.CompactionService,
        di.createDescriptor(compactionModule.CompactionService, {
          maxTokens: options.maxTokens,
          summarize: options.summarize ?? (async () => summary(0, 0, "compacted summary")),
        }),
      ],
      [agentLoop.AgentLoop, agentLoop.AgentLoop],
    ],
    setup: () => {
      contextSize.useContextSize();
      compactionModule.useCompaction();
    },
  });
}

function textResponseFetch(): typeof globalThis.fetch {
  return (async () => textResponse("ok")) as typeof globalThis.fetch;
}

function user(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

function assistant(text: string) {
  return llm.AssistantMessage.create({
    provider: "local",
    model: "chat",
    content: [llm.TextBlock.create({ text })],
  });
}

function system(text: string) {
  return llm.SystemMessage.create({ content: [llm.TextBlock.create({ text })] });
}

function seed(context: InstanceType<ContextModule["Context"]>): void {
  context.pending.push(system("old system"), user("old user message with enough text"));
  context.batch();
  context.pending.push(assistant("old assistant reply"));
  context.batch();
}

describe("useCompaction", () => {
  it("compacts old batches over budget and prepends the summary to recent messages", async () => {
    const summarized: unknown[] = [];
    const requests: Record<string, unknown>[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((await new Request(input, init).json()) as Record<string, unknown>);
      return textResponse("done");
    }) as typeof globalThis.fetch;
    const scope = createScope({
      maxTokens: 5,
      fetch,
      summarize: async ({ messages }) => {
        summarized.push(messages);
        return summary(0, 1);
      },
    });
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      const compaction = scope.get(compactionModule.CompactionService);
      seed(context);
      context.pending.push(user("recent question"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      expect(reason).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        messages: [
          { role: "system", content: "old system" },
          { role: "user", content: [{ type: "text", text: "summary" }] },
          { role: "user", content: [{ type: "text", text: "recent question" }] },
        ],
      });
      expect(requests[0]!["messages"]).toHaveLength(3);
      expect(summarized).toHaveLength(1);
      const summarizedMessages = summarized[0] as InstanceType<LlmModule["Message"]>[];
      expect(summarizedMessages.map((message) => messageText(message))).toEqual([
        "old user message with enough text",
        "old assistant reply",
      ]);
      expect(summarizedMessages[0]).toBeInstanceOf(llm.UserMessage);
      expect(summarizedMessages[1]).toBeInstanceOf(llm.AssistantMessage);
      expect(compaction.latestSlice).toMatchObject({ from: 0, to: 1 });
      expect(
        compaction.latestSlice?.systemMessages.map((message) => llm.extractText(message.content)),
      ).toEqual(["old system"]);
      expect(context.batchCount).toBe(3);
    } finally {
      scope.dispose();
    }
  });

  it("keeps system messages from compacted batches in front of recent system prompts", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((await new Request(input, init).json()) as Record<string, unknown>);
      return textResponse("done");
    }) as typeof globalThis.fetch;
    const scope = createScope({ maxTokens: 5, fetch });
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      seed(context);
      context.pending.push(system("recent system"), user("recent question"));

      await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      const messages = requests[0]!["messages"] as { role: string; content: string }[];
      expect(messages[0]).toEqual({
        role: "system",
        content: "old system\n\nrecent system",
      });
    } finally {
      scope.dispose();
    }
  });

  it("drops leading tool results and unresolved tool calls at the slice boundary", async () => {
    let fetchCalled = false;
    const fetch = (async () => {
      fetchCalled = true;
      return textResponse("unused");
    }) as typeof globalThis.fetch;
    const scope = createScope({ fetch });
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      const compaction = scope.get(compactionModule.CompactionService);

      context.pending.push(assistant("old"));
      context.batch();
      const orphanResult = llm.ToolResultMessage.create({
        toolCallId: "orphan",
        toolName: "read",
        content: [llm.TextBlock.create({ text: "orphan" })],
      });
      const toolCall = (id: string) =>
        llm.ToolCallBlock.create({ id, name: "read", arguments: "{}" });
      const callMessage = llm.AssistantMessage.create({
        provider: "local",
        model: "chat",
        content: [
          llm.TextBlock.create({ text: "working" }),
          toolCall("resolved"),
          toolCall("unresolved"),
        ],
      });
      const resolvedResult = llm.ToolResultMessage.create({
        toolCallId: "resolved",
        toolName: "read",
        content: [llm.TextBlock.create({ text: "ok" })],
      });
      const tail = [orphanResult, callMessage, resolvedResult, user("next")];

      await compaction.compact(0);
      const payload = await loop.hooks.transformContext.run({}, async () => ({
        systemPrompt: "runtime system",
        messages: tail,
      }));

      expect(messageText(payload.messages[0]!)).toBe("compacted summary");
      const filtered = payload.messages[1] as InstanceType<LlmModule["AssistantMessage"]>;
      expect(filtered.content).toHaveLength(2);
      expect(filtered.content[0]).toBeInstanceOf(llm.TextBlock);
      expect(filtered.content[1]).toMatchObject({ id: "resolved" });
      expect(payload.messages[2]).toBe(resolvedResult);
      expect(payload.messages[3]).toBe(tail[3]);
      expect(payload.messages).toHaveLength(4);
      expect(payload.systemPrompt).toBe("runtime system");
      expect(fetchCalled).toBe(false);
    } finally {
      scope.dispose();
    }
  });

  it("recovers from a context-overflow error by compacting and un-batching the failed attempt", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((await new Request(input, init).json()) as Record<string, unknown>);
      return requests.length === 1
        ? errorResponse("maximum context length exceeded", 400)
        : textResponse("recovered");
    }) as typeof globalThis.fetch;
    let summarizeCalls = 0;
    const scope = createScope({
      fetch,
      summarize: async () => {
        summarizeCalls += 1;
        return summary(0, 1, "overflow summary");
      },
    });
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      seed(context);
      context.pending.push(user("recent question"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      expect(reason).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(summarizeCalls).toBe(1);
      expect(requests[1]).toMatchObject({
        messages: [
          { role: "system", content: "old system" },
          { role: "user", content: [{ type: "text", text: "overflow summary" }] },
          { role: "user", content: [{ type: "text", text: "recent question" }] },
        ],
      });
    } finally {
      scope.dispose();
    }
  });
});

describe("defaultIsContextOverflowError", () => {
  it("recognises common provider overflow messages and ignores others", () => {
    expect(compactionModule.defaultIsContextOverflowError("context_length_exceeded")).toBe(true);
    expect(compactionModule.defaultIsContextOverflowError("maximum context window reached")).toBe(
      true,
    );
    expect(
      compactionModule.defaultIsContextOverflowError("prompt is too long for this model"),
    ).toBe(true);
    expect(compactionModule.defaultIsContextOverflowError("too many tokens in request")).toBe(true);
    expect(compactionModule.defaultIsContextOverflowError("token limit exceeded")).toBe(true);
    expect(compactionModule.defaultIsContextOverflowError("rate limit exceeded")).toBe(false);
    expect(compactionModule.defaultIsContextOverflowError("")).toBe(false);
  });
});
