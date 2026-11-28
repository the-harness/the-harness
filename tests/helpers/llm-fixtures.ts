import type { LlmProviderConfig } from "../../packages/llm/src/types.ts";

export function providerConfig(): LlmProviderConfig {
  return {
    id: "local",
    name: "Local",
    api: "openai-completions",
    baseUrl: "https://api.test/v1",
    apiKey: "test-key",
    headers: { "X-Provider": "provider" },
    models: [{ id: "chat", name: "Chat", contextWindow: 2_000, maxTokens: 200 }, { id: "small" }],
  };
}

export function chatChunk(
  content: string,
  finishReason: string | null = null,
  usage?: unknown,
): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "chat",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

export interface ToolCallFixture {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function toolCallChunk(call: ToolCallFixture, index: number, finishReason: string | null): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "chat",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  };
}

export function sseResponse(chunks: readonly unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function textResponse(text: string): Response {
  return sseResponse([
    chatChunk(text),
    chatChunk("", "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);
}

export function toolCallResponse(calls: readonly ToolCallFixture[]): Response {
  return sseResponse([
    ...calls.map((call, index) => toolCallChunk(call, index, null)),
    chatChunk("", "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);
}

export function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
