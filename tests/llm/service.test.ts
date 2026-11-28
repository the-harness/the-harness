import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { AssistantMessage, Message } from "../../packages/llm/src/message.ts";
import type { LlmChunk, LlmProviderConfig } from "../../packages/llm/src/types.ts";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type MessageModule = typeof import("../../packages/llm/src/message.ts");
type ServiceModule = typeof import("../../packages/llm/src/service.ts");

let harness: HarnessModules;
let messages: MessageModule;
let serviceModule: ServiceModule;
let userMessage: Message;

beforeAll(async () => {
  harness = await createHarnessModules();
  messages = await harness.load<MessageModule>("/packages/llm/src/message.ts");
  serviceModule = await harness.load<ServiceModule>("/packages/llm/src/service.ts");
  userMessage = messages.UserMessage.create({
    content: [messages.TextBlock.create({ text: "hello" })],
  });
});

afterAll(async () => {
  await harness.close();
});

function config(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: "local",
    name: "Local",
    api: "openai-completions",
    baseUrl: "https://api.test/v1",
    apiKey: "test-key",
    headers: { "X-Provider": "provider" },
    models: [
      {
        id: "chat",
        name: "Chat",
        contextWindow: 2_000,
        maxTokens: 200,
        headers: { "X-Model": "model" },
      },
      { id: "small" },
    ],
    ...overrides,
  };
}

function sseResponse(chunks: readonly unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatChunk(content: string, finishReason: string | null = null, usage?: unknown): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "chat",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

describe("provider registration", () => {
  it("lists registered models and resolves them by id", () => {
    const service = new serviceModule.LlmService({ providers: [config()] });
    try {
      expect(service.listModels().map((model) => `${model.provider}/${model.id}`)).toEqual([
        "local/chat",
        "local/small",
      ]);
      expect(service.listModels("local")).toHaveLength(2);
      expect(service.listModels("missing")).toEqual([]);
      expect(service.getModel("local", "chat")).toMatchObject({
        id: "chat",
        provider: "local",
        name: "Chat",
        api: "openai-completions",
        baseUrl: "https://api.test/v1",
        contextWindow: 2_000,
        maxTokens: 200,
      });
      expect(service.getModel("local", "missing")).toBeUndefined();
      expect(service.getModel("missing", "chat")).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("does not let a stale HMR registration remove its replacement", () => {
    const service = new serviceModule.LlmService();
    try {
      const first = service.registerProvider(config({ models: [{ id: "first" }] }));
      const second = service.registerProvider(config({ models: [{ id: "second" }] }));

      first.dispose();
      expect(service.getModel("local", "second")).toBeDefined();
      expect(service.getModel("local", "first")).toBeUndefined();

      second.dispose();
      expect(service.getModel("local", "second")).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("unregisters a whole batch and rejects work after disposal", () => {
    const service = new serviceModule.LlmService();
    const registration = service.registerProviders([
      config(),
      config({ id: "second", models: [{ id: "other" }] }),
    ]);
    try {
      expect(service.listModels()).toHaveLength(3);
      registration.dispose();
      registration.dispose();
      expect(service.listModels()).toEqual([]);
    } finally {
      service.dispose();
    }

    expect(() => service.registerProvider(config())).toThrow("llmService has been disposed");
    expect(() => service.stream({ provider: "local", model: "chat", messages: [] })).toThrow(
      "unknown model 'local/chat'",
    );
    expect(() => service.dispose()).not.toThrow();
  });
});

describe("streaming through a real provider adapter", () => {
  it("sends the request and maps the SSE response into chunks and a final message", async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const chunks = [
      chatChunk("Hello"),
      chatChunk(" world"),
      chatChunk("", "stop", {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      }),
    ];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      return sseResponse(chunks);
    };
    const service = new serviceModule.LlmService({
      providers: [config()],
      defaultOptions: {
        fetch,
        maxRetries: 0,
        headers: { "X-Default": "default" },
      },
    });
    try {
      const stream = service.stream({
        provider: "local",
        model: "chat",
        systemPrompt: "be concise",
        headers: { "x-default": "request", "X-Request": "request" },
        messages: [userMessage],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      });

      const received: LlmChunk[] = [];
      for await (const chunk of stream) received.push(chunk);
      const result = await stream.result();

      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe("https://api.test/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      expect(request.headers.get("x-model")).toBe("model");
      expect(request.headers.get("x-default")).toBe("request");
      expect(request.headers.get("x-request")).toBe("request");
      expect(request.body).toMatchObject({
        model: "chat",
        stream: true,
        messages: [
          { role: "system", content: "be concise" },
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        tools: [{ type: "function", function: { name: "read" } }],
      });

      expect(received.slice(0, -1)).toEqual([
        { type: "text_delta", delta: "Hello" },
        { type: "text_delta", delta: " world" },
      ]);
      const finish = received.at(-1) as {
        type: "finish";
        response: {
          stopReason: string;
          usage: unknown;
          message: AssistantMessage;
        };
      };
      expect(finish.type).toBe("finish");
      expect(finish.response.stopReason).toBe("stop");
      expect(finish.response.usage).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      });
      expect(finish.response.message).toBeInstanceOf(messages.AssistantMessage);
      expect(finish.response.message.provider).toBe("local");
      expect(finish.response.message.model).toBe("chat");
      expect(finish.response.message.content).toEqual([
        messages.TextBlock.create({ text: "Hello world" }),
      ]);
      expect(result.message).toBeInstanceOf(messages.AssistantMessage);
    } finally {
      service.dispose();
    }
  });

  it("surfaces provider HTTP failures as error responses instead of throwing from result", async () => {
    const service = new serviceModule.LlmService({
      providers: [config()],
      defaultOptions: {
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        maxRetries: 0,
      },
    });
    try {
      const stream = service.stream({
        provider: "local",
        model: "chat",
        messages: [userMessage],
      });
      const result = await stream.result();

      expect(result.stopReason).toBe("error");
      expect(result.error?.message).toContain("invalid api key");
      expect(result.message.content).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("applies provider-level headers to requests", async () => {
    const seen: Headers[] = [];
    const service = new serviceModule.LlmService({
      providers: [config()],
      defaultOptions: {
        fetch: async (input, init) => {
          seen.push(new Request(input, init).headers);
          return sseResponse([chatChunk("ok", "stop")]);
        },
        maxRetries: 0,
      },
    });
    try {
      await service.stream({ provider: "local", model: "chat", messages: [userMessage] }).result();
      expect(seen[0]!.get("x-provider")).toBe("provider");
    } finally {
      service.dispose();
    }
  });

  it("rejects immediately for an unregistered model", () => {
    const service = new serviceModule.LlmService({ providers: [config()] });
    try {
      expect(() => service.stream({ provider: "local", model: "missing", messages: [] })).toThrow(
        "unknown model 'local/missing'",
      );
    } finally {
      service.dispose();
    }
  });
});
