import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "../../packages/tool-call/node_modules/zod/index.js";
import type { ToolOutputChunk } from "../../packages/tool-call/src/index.ts";
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

const echoTool = {
  name: "echo",
  description: "Echo the input",
  parameters: z.object({ text: z.string() }),
  execute: ({ text }: { text: string }) => `echo:${text}`,
};

async function batchMessages(
  context: InstanceType<ContextModule["Context"]>,
): Promise<Array<InstanceType<LlmModule["Message"]>>> {
  const messages: Array<InstanceType<LlmModule["Message"]>> = [];
  for await (const batch of context.readBackward()) {
    messages.push(...batch.messages);
  }
  return messages;
}

function createScope() {
  const root = di.createRootScope();
  root.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    linkedTree.LinkedTree,
    di.createDescriptor(contextModule.Context, { id: "tool-loop" }),
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
    }),
  );
  root.run(() => {
    toolCallModule.useToolCall();
    root.get(toolCallModule.ToolCallService).useTool(toolCallModule.functionTool(echoTool));
  });
  return {
    root,
    context: root.get(contextModule.Context),
    loop: root.get(agentLoop.AgentLoop),
    tools: root.get(toolCallModule.ToolCallService),
    mock: providerScope.get(llm.LlmProvider) as InstanceType<
      MockLlmModule["ScriptedMockLlmProvider"]
    >,
  };
}

describe("agent loop tool execution", () => {
  it("executes a model tool call, feeds the result back and declares the tool in the request", async () => {
    const opened = createScope();
    try {
      opened.mock.enqueue({
        toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hi" } }],
        stopReason: "tool_calls",
      });
      opened.mock.enqueue({ text: "done" });
      opened.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "run" })] }),
      );

      expect(await opened.loop.run()).toBe("completed");
      expect(opened.mock.requests).toHaveLength(2);
      expect(opened.mock.requests[0]!.request.tools?.map((tool) => tool.name)).toEqual(["echo"]);
      expect(
        opened.mock.requests[0]!.request.messages.map((message) =>
          llm.extractText(message.content),
        ),
      ).toEqual(["run"]);

      const secondMessages = opened.mock.requests[1]!.request.messages;
      const assistant = secondMessages.find(
        (message) => message instanceof llm.AssistantMessage,
      ) as InstanceType<LlmModule["AssistantMessage"]> | undefined;
      const result = secondMessages.find((message) => message instanceof llm.ToolResultMessage) as
        | InstanceType<LlmModule["ToolResultMessage"]>
        | undefined;
      expect(assistant?.content).toHaveLength(1);
      expect(assistant?.content[0]).toBeInstanceOf(llm.ToolCallBlock);
      expect(result).toMatchObject({ toolCallId: "call-1", toolName: "echo", isError: false });
      expect(llm.extractText(result!.content)).toBe("echo:hi");

      const committed = await batchMessages(opened.context);
      const committedResults = committed
        .filter((message) => message instanceof llm.ToolResultMessage)
        .map((message) => llm.extractText(message.content));
      expect(committedResults).toEqual(["echo:hi"]);
      const final = opened.context.pending.find(
        (message) => message instanceof llm.AssistantMessage,
      );
      expect(
        final && llm.extractText((final as InstanceType<LlmModule["AssistantMessage"]>).content),
      ).toBe("done");
    } finally {
      opened.root.dispose();
    }
  });

  it("turns unknown tools and invalid arguments into error results without stopping the loop", async () => {
    const opened = createScope();
    try {
      opened.mock.enqueue({
        toolCalls: [
          { id: "missing-1", name: "missing", arguments: {} },
          { id: "bad-1", name: "echo", arguments: { text: 42 } },
        ],
        stopReason: "tool_calls",
      });
      opened.mock.enqueue({ text: "recovered" });
      opened.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "go" })] }),
      );

      expect(await opened.loop.run()).toBe("completed");
      const results = (await batchMessages(opened.context)).filter(
        (message): message is InstanceType<LlmModule["ToolResultMessage"]> =>
          message instanceof llm.ToolResultMessage,
      );
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.isError)).toBe(true);
      expect(llm.extractText(results[0]!.content)).toContain("Tool missing not found");
      expect(llm.extractText(results[1]!.content)).toContain("invalid tool arguments");
      expect(
        opened.context.pending.some(
          (message) =>
            message instanceof llm.AssistantMessage &&
            llm.extractText(message.content) === "recovered",
        ),
      ).toBe(true);
    } finally {
      opened.root.dispose();
    }
  });

  it("keeps a published tool result when the tool reuses its output array", async () => {
    const opened = createScope();
    const database = opened.root.get(sqlite.SqliteService);
    const published = Promise.withResolvers<InstanceType<LlmModule["ToolResultMessage"]>>();
    const resume = Promise.withResolvers<void>();
    const executedCalls: string[] = [];
    const outputChunks: ToolOutputChunk[] = [];
    let reportOutput: ((delta: string) => void) | undefined;
    let running: Promise<string> | undefined;
    try {
      const text = llm.TextBlock.create({ text: "published answer" });
      const image = llm.ImageBlock.create({ mimeType: "image/png", fileId: "tool-image" });
      const output = [text, image];
      const isResult = (
        message: InstanceType<LlmModule["Message"]>,
      ): message is InstanceType<LlmModule["ToolResultMessage"]> =>
        message instanceof llm.ToolResultMessage && message.toolCallId === "reuse-output";
      opened.root.run(() => {
        opened.tools.hooks.execute.use(({ call }, next) => {
          executedCalls.push(call.id);
          return next();
        });
        opened.tools.hooks.streamOutput.use((chunk, next) => {
          outputChunks.push(chunk);
          next();
        });
        opened.tools.useTool(toolCallModule.functionTool({
          name: "reusable",
          description: "Return a tool result",
          parameters: z.object({}),
          async execute(_input, context) {
            reportOutput = context.reportOutput;
            reportOutput?.("in progress");
            return output;
          },
        }));
        opened.loop.hooks.handleOutput.use(async (_input, next) => {
          const result = opened.context.pending.find(isResult);
          if (result) {
            published.resolve(result);
            await resume.promise;
          }
          await next();
        });
      });
      opened.mock.enqueue({ toolCalls: [{ id: "reuse-output", name: "reusable" }] }, "done");
      opened.context.pending.push(
        llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "run" })] }),
      );

      running = opened.loop.run();
      const result = await Promise.race([
        published.promise,
        running.then(() => {
          throw new Error("The agent loop did not publish its tool result");
        }),
      ]);
      reportOutput?.("already finished");
      expect(executedCalls).toEqual(["reuse-output"]);
      expect(outputChunks).toEqual([{ callId: "reuse-output", delta: "in progress" }]);
      output.splice(0, output.length, llm.TextBlock.create({ text: "buffer reused" }));
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toBe(text);
      expect(result.content[1]).toBe(image);
      resume.resolve();

      expect(await running).toBe("completed");
      const nextResult = opened.mock.requests[1]!.request.messages.find(isResult);
      expect(llm.extractText(nextResult!.content)).toBe("published answer");
      expect(nextResult!.content[1]).toBeInstanceOf(llm.ImageBlock);
      expect(nextResult!.content[1]).toMatchObject({ fileId: "tool-image" });
    } finally {
      resume.resolve();
      await running?.catch(() => {});
      opened.root.dispose();
      await database.close();
    }
  });
});
