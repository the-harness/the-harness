import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "../../packages/tool-call/node_modules/zod/index.js";
import type { Message as LlmMessage } from "../../packages/llm/src/message.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";
import { providerConfig, textResponse, toolCallResponse } from "../helpers/llm-fixtures.ts";

type AgentLoopModule = typeof import("../../packages/agent-loop/src/index.ts");
type CompactionModule = typeof import("../../packages/pi-compaction/src/index.ts");
type ContextModule = typeof import("../../packages/context/src/index.ts");
type ContextSizeModule = typeof import("../../packages/context-size/src/index.ts");
type DiModule = typeof import("../../packages/di/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type ToolCallModule = typeof import("../../packages/tool-call/src/index.ts");

let harness: HarnessModules;
let agentLoop: AgentLoopModule;
let compactionModule: CompactionModule;
let contextModule: ContextModule;
let contextSize: ContextSizeModule;
let di: DiModule;
let llm: LlmModule;
let toolCallModule: ToolCallModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [agentLoop, compactionModule, contextModule, contextSize, di, llm, toolCallModule] =
    await Promise.all([
      harness.load<AgentLoopModule>("/packages/agent-loop/src/index.ts"),
      harness.load<CompactionModule>("/packages/pi-compaction/src/index.ts"),
      harness.load<ContextModule>("/packages/context/src/index.ts"),
      harness.load<ContextSizeModule>("/packages/context-size/src/index.ts"),
      harness.load<DiModule>("/packages/di/src/index.ts"),
      harness.load<LlmModule>("/packages/llm/src/index.ts"),
      harness.load<ToolCallModule>("/packages/tool-call/src/index.ts"),
    ]);
});

afterAll(async () => {
  await harness.close();
});

interface ScopeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly register?: (service: InstanceType<ToolCallModule["ToolCallService"]>) => void;
}

function createScope(options: ScopeOptions = {}) {
  return di.createRootScope({
    services: [
      [contextModule.Context, di.createDescriptor(contextModule.Context, { id: "tool-call" })],
      [
        llm.LlmService,
        di.createDescriptor(llm.LlmService, {
          providers: [providerConfig()],
          defaultOptions: {
            fetch:
              options.fetch ?? ((async () => textResponse("unused")) as typeof globalThis.fetch),
            maxRetries: 0,
          },
        }),
      ],
      [
        compactionModule.CompactionService,
        di.createDescriptor(compactionModule.CompactionService, {
          summarize: async () => llm.UserMessage.create({ content: [] }),
        }),
      ],
      [contextSize.ContextSizeService, contextSize.ContextSizeService],
      [toolCallModule.ToolCallService, toolCallModule.ToolCallService],
      [agentLoop.AgentLoop, agentLoop.AgentLoop],
    ],
    setup: () => {
      toolCallModule.useToolCall();
      toolCallModule.useToolCallCompaction();
      options.register?.(di.inject(toolCallModule.ToolCallService));
    },
  });
}

function useTool(
  service: InstanceType<ToolCallModule["ToolCallService"]>,
  definition: unknown,
): void {
  service.useTool(toolCallModule.functionTool(definition as never));
}

function messageText(message: LlmMessage): string {
  return llm.extractText((message as InstanceType<LlmModule["ContentMessage"]>).content);
}

function user(text: string) {
  return llm.UserMessage.create({ content: [llm.TextBlock.create({ text })] });
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return llm.ToolCallBlock.create({ id, name, arguments: JSON.stringify(args) });
}

function textOf(result: InstanceType<LlmModule["ToolResultMessage"]>): string {
  return llm.extractText(result.content);
}

const echoTool = {
  name: "echo",
  description: "Echo the input",
  parameters: z.object({ text: z.string() }),
  execute: ({ text }: { text: string }) => `done:${text}`,
};

const echoDeclaration = () =>
  llm.FunctionToolDeclaration.create({
    name: echoTool.name,
    description: echoTool.description,
    parameters: z.toJSONSchema(echoTool.parameters) as Record<string, unknown>,
  });

describe("ToolCallService", () => {
  it("registers tools as supplementary context and removes them on scope disposal", () => {
    const scope = createScope({
      register: (service) => {
        useTool(service, echoTool);
        useTool(service, {
          name: "alpha",
          description: "first",
          parameters: z.object({}),
          execute: () => "alpha",
        });
        useTool(service, {
          name: "beta",
          description: "second",
          parameters: z.object({}),
          execute: () => "beta",
        });
      },
    });
    const context = scope.get(contextModule.Context);
    const service = scope.get(toolCallModule.ToolCallService);
    try {
      expect(context.pending.map((message) => message.constructor.name)).toEqual([
        "AddToolMessage",
        "AddToolMessage",
        "AddToolMessage",
      ]);
      expect(service.tools.map((tool) => tool.declaration().name)).toEqual(["echo", "alpha", "beta"]);
      for (const message of context.pending) {
        expect(message.meta.get(agentLoop.SupplementaryField)).toBe(true);
      }

      expect(() => scope.run(() => useTool(service, echoTool))).toThrow(
        "tool 'echo' is already registered",
      );
    } finally {
      scope.dispose();
    }

    expect(context.pending.slice(0, 3).map((message) => message.constructor.name)).toEqual([
      "AddToolMessage",
      "AddToolMessage",
      "AddToolMessage",
    ]);
    expect(context.pending.slice(3).map((message) => message.constructor.name)).toEqual([
      "RemoveToolMessage",
      "RemoveToolMessage",
      "RemoveToolMessage",
    ]);
    expect(service.tools).toEqual([]);
    expect(() => useTool(service, echoTool)).toThrow(
      "ToolCallService.useTool() must be called within an active EffectScope",
    );
  });

  it("executes tool calls end-to-end and feeds results back into the loop", async () => {
    const executions: unknown[] = [];
    const requests: Record<string, unknown>[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((await new Request(input, init).json()) as Record<string, unknown>);
      return requests.length === 1
        ? toolCallResponse([{ id: "call_1", name: "echo", arguments: { text: "hi" } }])
        : textResponse("final");
    }) as typeof globalThis.fetch;
    const scope = createScope({
      fetch,
      register: (service) =>
        useTool(service, {
          ...echoTool,
          execute: (input: { text: string }, ctx: { readonly callId: string }) => {
            executions.push({ input, callId: ctx.callId });
            return `done:${input.text}`;
          },
        }),
    });
    try {
      const context = scope.get(contextModule.Context);
      const loop = scope.get(agentLoop.AgentLoop);
      context.pending.push(user("run"));

      const reason = await loop.run({ provider: "local", model: "chat", maxSteps: 3 });

      expect(reason).toBe("completed");
      expect(executions).toEqual([{ input: { text: "hi" }, callId: "call_1" }]);
      expect(requests).toHaveLength(2);
      expect(requests[0]!["tools"]).toMatchObject([
        { type: "function", function: { name: "echo" } },
      ]);
      expect(requests[1]).toMatchObject({
        messages: [
          { role: "user", content: [{ type: "text", text: "run" }] },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"text":"hi"}' },
              },
            ],
          },
          { role: "tool", content: "done:hi", tool_call_id: "call_1" },
        ],
      });
      expect(context.pending).toHaveLength(1);
      expect(messageText(context.pending[0]!)).toBe("final");
    } finally {
      scope.dispose();
    }
  });

  it("turns unknown tools, invalid arguments, thrown errors and aborts into error results", async () => {
    const scope = createScope({
      register: (service) => {
        useTool(service, echoTool);
        useTool(service, {
          name: "content",
          description: "returns blocks",
          parameters: z.object({}),
          execute: () => [llm.TextBlock.create({ text: "block result" })],
        });
        useTool(service, {
          name: "throws",
          description: "throws",
          parameters: z.object({}),
          execute: () => {
            throw new Error("tool exploded");
          },
        });
      },
    });
    try {
      const service = scope.get(toolCallModule.ToolCallService);
      const results = await service.execute([
        toolCall("unknown", "missing", {}),
        llm.ToolCallBlock.create({ id: "bad-json", name: "echo", arguments: "{bad" }),
        toolCall("bad-schema", "echo", { text: 1 }),
        toolCall("throw", "throws", {}),
        toolCall("blocks", "content", {}),
      ]);

      expect(results.map((result) => result.isError)).toEqual([true, true, true, true, false]);
      expect(textOf(results[0]!)).toBe("unknown tool 'missing'");
      expect(textOf(results[1]!)).toContain("invalid tool arguments");
      expect(textOf(results[2]!)).toContain("invalid tool arguments");
      expect(textOf(results[3]!)).toBe("tool exploded");
      expect(results[4]!.content).toEqual([llm.TextBlock.create({ text: "block result" })]);
      expect(results.map((result) => result.toolCallId)).toEqual([
        "unknown",
        "bad-json",
        "bad-schema",
        "throw",
        "blocks",
      ]);

      const aborted = new AbortController();
      aborted.abort();
      const [abortedResult] = await service.execute(
        [toolCall("aborted", "echo", { text: "no" })],
        aborted.signal,
      );
      expect(abortedResult!.isError).toBe(true);
      expect(textOf(abortedResult!)).toBe("tool execution aborted");
    } finally {
      scope.dispose();
    }
  });

  it("deduplicates add/remove tool messages in one batch", () => {
    const scope = createScope({
      register: (service) => useTool(service, echoTool),
    });
    try {
      const context = scope.get(contextModule.Context);
      const add = toolCallModule.AddToolMessage.create({ tool: echoDeclaration(), content: [] });
      const remove = toolCallModule.RemoveToolMessage.create({ toolName: "echo", content: [] });

      context.pending.push(add, remove);
      const batch = context.batch();

      expect(batch.messages).toEqual([]);
    } finally {
      scope.dispose();
    }
  });

  it("removes tool messages from the payload and injects sorted active tools", async () => {
    const scope = createScope({
      register: (service) => {
        useTool(service, {
          name: "alpha",
          description: "first",
          parameters: z.object({}),
          execute: () => "alpha",
        });
        useTool(service, echoTool);
      },
    });
    try {
      const loop = scope.get(agentLoop.AgentLoop);
      const service = scope.get(toolCallModule.ToolCallService);
      const declarations = service.tools.map((tool) => tool.declaration());
      const addEcho = toolCallModule.AddToolMessage.create({
        tool: declarations.find((tool) => tool.name === "echo")!,
        content: [],
      });
      const addAlpha = toolCallModule.AddToolMessage.create({
        tool: declarations.find((tool) => tool.name === "alpha")!,
        content: [],
      });
      const remove = toolCallModule.RemoveToolMessage.create({ toolName: "missing", content: [] });
      const payload = await loop.hooks.transformContext.run({}, async () => ({
        systemPrompt: "system",
        messages: [addEcho, addAlpha, remove, user("hello")],
      }));

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]).toBeInstanceOf(llm.UserMessage);
      expect(payload.tools?.map((tool) => tool.name)).toEqual(["alpha", "echo"]);
    } finally {
      scope.dispose();
    }
  });

  it("reorders tool results directly after their assistant call", async () => {
    const scope = createScope();
    try {
      const loop = scope.get(agentLoop.AgentLoop);
      const callA = toolCall("a", "echo", { text: "a" });
      const callB = toolCall("b", "echo", { text: "b" });
      const assistant = llm.AssistantMessage.create({
        provider: "local",
        model: "chat",
        content: [callA, callB],
      });
      const resultB = llm.ToolResultMessage.create({
        toolCallId: "b",
        toolName: "echo",
        content: [llm.TextBlock.create({ text: "b" })],
      });
      const resultA = llm.ToolResultMessage.create({
        toolCallId: "a",
        toolName: "echo",
        content: [llm.TextBlock.create({ text: "a" })],
      });

      const next = user("next");
      const payload = await loop.hooks.transformContext.run({}, async () => ({
        messages: [assistant, resultB, resultA, next],
      }));

      const payloadNext = payload.messages[3]!;
      expect(payload.messages[0]).toBe(assistant);
      expect(payload.messages[1]).toBe(resultA);
      expect(payload.messages[2]).toBe(resultB);
      expect(payloadNext).toBeInstanceOf(llm.UserMessage);
      expect(messageText(payloadNext)).toBe("next");
    } finally {
      scope.dispose();
    }
  });

  it("folds tool definitions around compaction and keeps active tools", async () => {
    const scope = createScope({
      register: (service) => useTool(service, echoTool),
    });
    try {
      const compaction = scope.get(compactionModule.CompactionService);
      const add = toolCallModule.AddToolMessage.create({
        tool: echoDeclaration(),
        content: [],
      });
      const remove = toolCallModule.RemoveToolMessage.create({
        toolName: "other",
        content: [],
      });
      const summary = llm.UserMessage.create({
        content: [llm.TextBlock.create({ text: "summary" })],
      });
      let seen: readonly LlmMessage[] = [];

      const result = await compaction.hooks.compact.run(
        { messages: [add, user("kept"), remove] },
        async (input) => {
          seen = input.messages;
          return [summary];
        },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(llm.UserMessage);
      expect(messageText(seen[0]!)).toBe("kept");
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(summary);
      expect(result[1]).toBe(add);
    } finally {
      scope.dispose();
    }
  });
});
