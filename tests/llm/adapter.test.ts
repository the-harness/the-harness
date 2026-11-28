import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type Model,
  type ProviderAuth,
} from "../../packages/llm/node_modules/@earendil-works/pi-ai/dist/index.js";
import { AssistantMessageEventStream } from "../../packages/llm/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import type { AssistantMessage, Message } from "../../packages/llm/src/message.ts";
import type { LlmChunk, LlmProviderConfig } from "../../packages/llm/src/types.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type AdapterModule = typeof import("../../packages/llm/src/adapter.ts");
type MessageModule = typeof import("../../packages/llm/src/message.ts");

let harness: HarnessModules;
let adapter: AdapterModule;
let messages: MessageModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  adapter = await harness.load<AdapterModule>("/packages/llm/src/adapter.ts");
  messages = await harness.load<MessageModule>("/packages/llm/src/message.ts");
});

afterAll(async () => {
  await harness.close();
});

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function piModel(api: Api = "openai-completions"): Model<Api> {
  return {
    id: "target",
    name: "Target",
    api,
    provider: "local",
    baseUrl: "https://api.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function assistant(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "local",
    model: "target",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function providerConfig(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: "local",
    name: "Local",
    api: "openai-completions",
    baseUrl: "https://api.test/v1",
    apiKey: "configured-key",
    models: [{ id: "target" }],
    ...overrides,
  };
}

describe("provider and model conversion", () => {
  it("fills model defaults and keeps per-model overrides", () => {
    const provider = adapter.toPiProvider(
      providerConfig({
        baseUrl: "https://provider.test/v1",
        headers: { "X-Provider": "provider" },
        models: [
          { id: "defaults" },
          {
            id: "custom",
            name: "Custom",
            baseUrl: "https://model.test/v1",
            reasoning: true,
            inputModalities: ["text", "image"],
            contextWindow: 64_000,
            maxTokens: 4_096,
            headers: { "X-Model": "model" },
          },
        ],
      }),
    );

    const models = provider.getModels();
    expect(adapter.fromPiModel(models[0]!)).toEqual({
      id: "defaults",
      provider: "local",
      name: "defaults",
      api: "openai-completions",
      baseUrl: "https://provider.test/v1",
      reasoning: false,
      inputModalities: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      headers: undefined,
    });
    expect(adapter.fromPiModel(models[1]!)).toMatchObject({
      id: "custom",
      name: "Custom",
      baseUrl: "https://model.test/v1",
      reasoning: true,
      inputModalities: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4_096,
      headers: { "X-Model": "model" },
    });
  });

  it("rejects protocols without an adapter instead of silently falling back", () => {
    expect(() => adapter.toPiProvider(providerConfig({ api: "not-a-protocol" }))).toThrow(
      "unsupported llm protocol 'not-a-protocol'",
    );
  });

  it("resolves configured, functional, and stored credentials through provider auth", async () => {
    const resolve = async (
      config: LlmProviderConfig,
      credential?: { type: "api_key"; key?: string },
      signal = new AbortController().signal,
    ) => {
      const auth = adapter.toPiProvider(config).auth as ProviderAuth;
      return auth.apiKey!.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        credential,
        signal,
      });
    };

    expect(await resolve(providerConfig())).toEqual({
      auth: { apiKey: "configured-key" },
      source: "configured",
    });
    expect(await resolve(providerConfig({ apiKey: async () => "functional-key" }))).toEqual({
      auth: { apiKey: "functional-key" },
      source: "configured",
    });
    expect(await resolve(providerConfig(), { type: "api_key", key: "stored-key" })).toEqual({
      auth: { apiKey: "stored-key" },
      source: "credential",
    });
    expect(await resolve(providerConfig({ apiKey: undefined }))).toBeUndefined();
    expect(await resolve(providerConfig({ apiKey: () => "" }))).toBeUndefined();

    const aborted = new AbortController();
    aborted.abort();
    await expect(resolve(providerConfig(), undefined, aborted.signal)).rejects.toThrow();
  });
});

describe("message conversion", () => {
  it("normalizes every message role and drops blocks a user message cannot carry", () => {
    const list: Message[] = [
      messages.SystemMessage.create({
        content: [
          messages.TextBlock.create({ text: "first" }),
          messages.ThinkingBlock.create({ thinking: "ignored" }),
          messages.TextBlock.create({ text: " second" }),
        ],
      }),
      messages.DeveloperMessage.create({
        content: [messages.TextBlock.create({ text: "developer note" })],
      }),
      messages.UserMessage.create({
        content: [
          messages.TextBlock.create({ text: "describe" }),
          messages.ImageBlock.create({ data: "AAAA", mimeType: "image/png" }),
          messages.ToolCallBlock.create({ id: "ignored", name: "ignored", arguments: "{}" }),
        ],
      }),
      messages.AssistantMessage.create({
        provider: "local",
        model: "target",
        replayState: { api: "x" },
        content: [
          messages.TextBlock.create({ text: "answer" }),
          messages.ThinkingBlock.create({
            thinking: "reason",
            signature: "sig",
            redacted: true,
          }),
          messages.ToolCallBlock.create({
            id: "call_1",
            name: "read",
            arguments: '{"path":"/a"}',
          }),
          messages.ImageBlock.create({ data: "BBBB", mimeType: "image/png" }),
        ],
      }),
      messages.ToolResultMessage.create({
        toolCallId: "call_1",
        toolName: "read",
        isError: true,
        content: [messages.TextBlock.create({ text: "failed" })],
      }),
    ];

    const context = adapter.toPiContext(
      {
        provider: "local",
        model: "target",
        systemPrompt: "system prompt",
        messages: list,
        tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      },
      piModel(),
    );

    expect(context.systemPrompt).toBe("system prompt");
    expect(context.tools).toEqual([
      { name: "read", description: "Read a file", parameters: { type: "object" } },
    ]);
    expect(context.messages).toEqual([
      { role: "system", content: "first second", timestamp: 0 },
      {
        role: "user",
        content: [{ type: "text", text: "developer note" }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          {
            type: "thinking",
            thinking: "reason",
            thinkingSignature: "sig",
            redacted: true,
          },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "/a" },
            thoughtSignature: undefined,
          },
        ],
        api: "x",
        provider: "local",
        model: "target",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 0,
      },
    ]);
  });

  it("tolerates malformed tool arguments and empty user content", () => {
    const context = adapter.toPiContext(
      {
        provider: "local",
        model: "target",
        messages: [
          messages.AssistantMessage.create({
            provider: "local",
            model: "target",
            content: [
              messages.ToolCallBlock.create({ id: "a", name: "empty", arguments: "  " }),
              messages.ToolCallBlock.create({
                id: "b",
                name: "invalid",
                arguments: "{not json",
              }),
              messages.ToolCallBlock.create({
                id: "c",
                name: "array",
                arguments: "[1,2]",
              }),
              messages.ToolCallBlock.create({
                id: "d",
                name: "number",
                arguments: "42",
              }),
            ],
          }),
          messages.UserMessage.create({ content: [] }),
        ],
      },
      piModel("anthropic-messages"),
    );

    expect(context.messages[0]).toMatchObject({
      role: "assistant",
      api: "anthropic-messages",
      content: [
        { type: "toolCall", id: "a", arguments: {} },
        { type: "toolCall", id: "b", arguments: {} },
        { type: "toolCall", id: "c", arguments: {} },
        { type: "toolCall", id: "d", arguments: {} },
      ],
    });
    expect(context.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "" }],
      timestamp: 0,
    });
  });
});

describe("stream options", () => {
  it("merges defaults with request overrides and case-insensitive headers", () => {
    const fetch = async () => new Response();
    const signal = new AbortController().signal;
    const options = adapter.toPiStreamOptions(
      {
        fetch,
        timeoutMs: 5_000,
        maxRetries: 1,
        cacheRetention: "long",
        headers: { Authorization: "default", "X-Shared": "default", "X-Default": "kept" },
      },
      {
        provider: "local",
        model: "target",
        messages: [],
        headers: { authorization: "request", "x-shared": "request" },
        apiKey: "request-key",
        sessionId: "session",
        temperature: 0.5,
        maxTokens: 123,
        thinkingBudgets: { low: 10 },
        reasoning: "high",
        signal,
      },
    );

    expect(options).toMatchObject({
      fetch,
      timeoutMs: 5_000,
      maxRetries: 1,
      cacheRetention: "long",
      reasoning: "high",
      thinkingBudgets: { low: 10 },
      temperature: 0.5,
      maxTokens: 123,
      sessionId: "session",
      apiKey: "request-key",
      signal,
      headers: {
        "X-Default": "kept",
        authorization: "request",
        "x-shared": "request",
      },
    });
  });

  it("maps reasoning off to no reasoning and lets the request override cache retention", () => {
    const options = adapter.toPiStreamOptions(
      { cacheRetention: "short" },
      {
        provider: "local",
        model: "target",
        messages: [],
        cacheRetention: "none",
        reasoning: "off",
      },
    );

    expect(options.reasoning).toBeUndefined();
    expect(options.cacheRetention).toBe("none");
    expect(
      adapter.toPiStreamOptions(undefined, { provider: "local", model: "m", messages: [] }),
    ).toEqual({
      fetch: undefined,
      timeoutMs: undefined,
      maxRetries: undefined,
      headers: undefined,
      cacheRetention: undefined,
      reasoning: undefined,
      thinkingBudgets: undefined,
      temperature: undefined,
      maxTokens: undefined,
      sessionId: undefined,
      apiKey: undefined,
      signal: undefined,
    });
  });
});

describe("stream wrapping", () => {
  it("maps deltas, tool calls, and the final response from pi events", async () => {
    const source = new AssistantMessageEventStream();
    const partial = assistant({
      content: [
        { type: "text", text: "" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ],
    });
    const final = assistant({
      content: [
        { type: "text", text: "Hello world" },
        { type: "thinking", thinking: "plan", thinkingSignature: "sig", redacted: false },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "/a" },
        },
      ],
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });

    source.push({ type: "start", partial });
    source.push({ type: "text_start", contentIndex: 0, partial });
    source.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial });
    source.push({ type: "text_delta", contentIndex: 0, delta: " world", partial });
    source.push({ type: "text_end", contentIndex: 0, content: "Hello world", partial });
    source.push({ type: "thinking_start", contentIndex: 1, partial });
    source.push({ type: "thinking_delta", contentIndex: 1, delta: "plan", partial });
    source.push({ type: "toolcall_start", contentIndex: 1, partial });
    source.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":', partial });
    source.push({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/a" } },
      partial,
    });
    source.push({ type: "done", reason: "toolUse", message: final });

    const stream = adapter.wrapPiStream(source);
    const chunks: LlmChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const result = await stream.result();

    expect(chunks.slice(0, -1)).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "thinking_delta", delta: "plan" },
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", delta: '{"path":' },
      { type: "tool_call_end", id: "call_1", name: "read", arguments: '{"path":"/a"}' },
    ]);
    const finish = chunks.at(-1) as {
      type: "finish";
      response: { stopReason: string; usage: unknown; message: AssistantMessage };
    };
    expect(finish.type).toBe("finish");
    expect(finish.response.stopReason).toBe(result.stopReason);
    expect(finish.response.usage).toEqual(result.usage);
    expect(finish.response.message.content).toEqual(result.message.content);
    expect(finish.response.message.provider).toBe("local");
    expect(result.stopReason).toBe("tool_calls");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: undefined,
      totalTokens: 15,
    });
    expect(result.error).toBeUndefined();
    expect(result.message).toBeInstanceOf(messages.AssistantMessage);
    expect(result.message.provider).toBe("local");
    expect(result.message.model).toBe("target");
    expect(result.message.replayState).toEqual({ api: "openai-completions" });
    expect(result.message.content).toEqual([
      messages.TextBlock.create({ text: "Hello world" }),
      messages.ThinkingBlock.create({
        thinking: "plan",
        signature: "sig",
        redacted: false,
      }),
      messages.ToolCallBlock.create({
        id: "call_1",
        name: "read",
        arguments: '{"path":"/a"}',
      }),
    ]);
  });

  it("turns error and aborted stop reasons into finish responses", async () => {
    const errorStream = new AssistantMessageEventStream();
    errorStream.push({
      type: "error",
      reason: "error",
      error: assistant({ stopReason: "error", errorMessage: "upstream exploded" }),
    });
    const errorResult = await adapter.wrapPiStream(errorStream).result();
    expect(errorResult.stopReason).toBe("error");
    expect(errorResult.error).toEqual({ message: "upstream exploded" });

    const abortedStream = new AssistantMessageEventStream();
    abortedStream.push({
      type: "error",
      reason: "aborted",
      error: assistant({ stopReason: "aborted" }),
    });
    const abortedResult = await adapter.wrapPiStream(abortedStream).result();
    expect(abortedResult.stopReason).toBe("aborted");
    expect(abortedResult.error).toBeUndefined();

    const defaultError = new AssistantMessageEventStream();
    defaultError.push({
      type: "error",
      reason: "error",
      error: assistant({ stopReason: "error" }),
    });
    expect((await adapter.wrapPiStream(defaultError).result()).error).toEqual({
      message: "LLM request failed",
    });
  });

  it("maps length stops and omits zero-valued cache usage", async () => {
    const source = new AssistantMessageEventStream();
    source.push({
      type: "done",
      reason: "length",
      message: assistant({
        stopReason: "length",
        content: [{ type: "text", text: "cut" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    });

    const result = await adapter.wrapPiStream(source).result();
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      totalTokens: 2,
    });
  });
});
