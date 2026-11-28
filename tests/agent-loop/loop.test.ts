import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";
import { errorResponse, providerConfig, textResponse } from "../helpers/llm-fixtures.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let contextModule: ContextModule;
let di: DiModule;
let llm: LlmModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [agentLoop, contextModule, di, llm] = await Promise.all([
    harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
    harness.load<ContextModule>("/packages/context/src/index.ts"),
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

interface RequestRecord {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function createScope(fetch: typeof globalThis.fetch, setup?: () => void) {
  return di.createRootScope({
    services: [
      [contextModule.Context, di.createDescriptor(contextModule.Context, { id: "loop-session" })],
      [
        llm.LlmService,
        di.createDescriptor(llm.LlmService, {
          providers: [providerConfig()],
          defaultOptions: { fetch, maxRetries: 0 },
        }),
      ],
      [agentLoop.AgentLoop, agentLoop.AgentLoop],
    ],
    setup,
  });
}

function recordingFetch(responses: readonly (() => Response)[]): {
  readonly requests: RequestRecord[];
  readonly fetch: typeof globalThis.fetch;
} {
  const requests: RequestRecord[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      body: (await request.clone().json()) as Record<string, unknown>,
    });
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error("unexpected extra request");
    return response();
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

function messageText(message: InstanceType<LlmModule["Message"]>): string {
  return llm.extractText((message as InstanceType<LlmModule["ContentMessage"]>).content);
}

function userMessage(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

describe("AgentLoop with a real context and provider adapter", () => {
  it("streams a reply, commits it to the context and aggregates system prompts", async () => {
    const { requests, fetch } = recordingFetch([() => textResponse("Hi there")]);
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      context.pending.push(
        llm.SystemMessage.create({ content: [llm.TextBlock.create({ text: "first" })] }),
        userMessage("hello"),
        llm.SystemMessage.create({ content: [llm.TextBlock.create({ text: "second" })] }),
      );

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      expect(reason).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body).toMatchObject({
        model: "chat",
        stream: true,
        messages: [
          { role: "system", content: "first\n\nsecond" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      });
      expect(context.batchCount).toBe(1);
      expect(context.pending).toHaveLength(1);
      expect(context.pending[0]).toBeInstanceOf(llm.AssistantMessage);
      expect(messageText(context.pending[0]!)).toBe("Hi there");

      const batches = [];
      for await (const batch of context.readBackward()) batches.push(batch);
      expect(batches[0]!.messages).toHaveLength(3);
      expect(batches[0]!.messages[0]).toBeInstanceOf(llm.SystemMessage);
      expect(batches[0]!.messages[1]).toBeInstanceOf(llm.UserMessage);
      expect(batches[0]!.messages[2]).toBeInstanceOf(llm.SystemMessage);
    } finally {
      scope.dispose();
    }
  });

  it("keeps looping while handleOutput adds new input and stops when nothing remains", async () => {
    const { requests, fetch } = recordingFetch([
      () => textResponse("one"),
      () => textResponse("two"),
    ]);
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      let followUps = 0;
      scope.run(() =>
        loop.hooks.handleOutput.use(async (_response, next) => {
          if (followUps === 0) {
            followUps += 1;
            context.pending.push(userMessage("follow up"));
          }
          await next();
        }),
      );
      context.pending.push(userMessage("start"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 4 });

      expect(reason).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(context.batchCount).toBe(2);
      expect(context.pending).toHaveLength(1);
      expect(messageText(context.pending[0]!)).toBe("two");
      expect(requests[1]!.body).toMatchObject({
        messages: [
          { role: "user", content: [{ type: "text", text: "start" }] },
          { role: "assistant", content: "one" },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
      });
    } finally {
      scope.dispose();
    }
  });

  it("returns max_steps after the budget without committing another batch", async () => {
    const { requests, fetch } = recordingFetch([() => textResponse("only")]);
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      scope.run(() =>
        loop.hooks.handleOutput.use(async (_response, next) => {
          context.pending.push(userMessage("again"));
          await next();
        }),
      );
      context.pending.push(userMessage("start"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 1 });

      expect(reason).toBe("max_steps");
      expect(requests).toHaveLength(1);
      expect(context.batchCount).toBe(1);
      expect(context.pending).toHaveLength(2);
      expect(context.pending[1]).toBeInstanceOf(llm.UserMessage);
    } finally {
      scope.dispose();
    }
  });

  it("aborts an in-flight request and restores the uncommitted pending messages", async () => {
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      started();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as typeof globalThis.fetch;
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      context.pending.push(userMessage("hello"));

      const running = loop.run({ provider: "local", model: "chat", maxSteps: 3 });
      await fetchStarted;
      expect(loop.isRunning).toBe(true);
      expect(() => loop.run({ provider: "local", model: "chat" })).toThrow(
        "loop is already running for context 'loop-session'",
      );
      loop.abort();

      await expect(running).resolves.toBe("aborted");
      expect(loop.isRunning).toBe(false);
      expect(context.batchCount).toBe(0);
      expect(context.pending).toHaveLength(1);
      expect(context.pending[0]).toBeInstanceOf(llm.UserMessage);
    } finally {
      scope.dispose();
    }
  });

  it("recovers from a provider failure through handleError and retries the request", async () => {
    const errors: string[] = [];
    const { requests, fetch } = recordingFetch([
      () => errorResponse("temporary upstream failure", 503),
      () => textResponse("recovered"),
    ]);
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      scope.run(() =>
        loop.hooks.handleError.use(async (error, next) => {
          if (errors.length === 0) {
            errors.push(error instanceof Error ? error.message : String(error));
            context.unbatch();
            return;
          }
          await next();
        }),
      );
      context.pending.push(userMessage("hello"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      expect(reason).toBe("completed");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("temporary upstream failure");
      expect(requests).toHaveLength(2);
    } finally {
      scope.dispose();
    }
  });

  it("stops on max_tokens and uncommits the request batch", async () => {
    const { fetch } = recordingFetch([
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "chat",
            choices: [{ index: 0, delta: { content: "cut" }, finish_reason: "length" }],
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    const scope = createScope(fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      context.pending.push(userMessage("hello"));

      await expect(loop.run({ provider: "local", model: "chat" })).resolves.toBe("max_tokens");
      expect(context.batchCount).toBe(0);
      expect(context.pending).toHaveLength(1);
    } finally {
      scope.dispose();
    }
  });

  it("only sends when there is input and every tool call is resolved", () => {
    const scope = createScope(recordingFetch([]).fetch);
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);

      expect(loop.shouldSend()).toBe(false);

      context.pending.push(userMessage("hello"));
      expect(loop.shouldSend()).toBe(true);

      context.pending.splice(0);
      context.pending.push(
        llm.AssistantMessage.create({
          provider: "local",
          model: "chat",
          content: [llm.ToolCallBlock.create({ id: "call_1", name: "read", arguments: "{}" })],
        }),
      );
      expect(loop.shouldSend()).toBe(false);

      context.pending.push(
        llm.ToolResultMessage.create({
          toolCallId: "call_1",
          toolName: "read",
          content: [llm.TextBlock.create({ text: "ok" })],
        }),
      );
      expect(loop.shouldSend()).toBe(true);

      context.pending.splice(0);
      const meta = new llm.MessageMeta().set(agentLoop.SupplementaryField, true);
      context.pending.push(llm.UserMessage.create({ content: [], meta }));
      expect(loop.shouldSend()).toBe(false);
    } finally {
      scope.dispose();
    }
  });
});
