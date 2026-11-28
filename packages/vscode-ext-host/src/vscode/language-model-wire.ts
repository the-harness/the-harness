import {
  CancellationError,
  LanguageModelChatMessage,
  LanguageModelDataPart,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "@harness/vscode-types";

export type ModelSelector = { id?: string; vendor?: string; family?: string; version?: string };
export type ModelInformation = {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput?: boolean; toolCalling?: boolean | number };
  [key: string]: unknown;
};
export type ModelSnapshot = ModelInformation & { vendor: string; handle: string };
export type ModelOptions = {
  justification?: string;
  tools?: readonly { name: string; description: string; inputSchema?: Record<string, unknown> }[];
  toolMode?: number;
  modelOptions?: Record<string, unknown>;
  [key: string]: unknown;
};
export type PartData =
  | { type: "text"; value: string; audience?: number[] }
  | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
  | { type: "toolCall"; callId: string; name: string; input: unknown }
  | { type: "toolResult"; callId: string; content: PartData[]; isError?: boolean }
  | { type: "data"; data: number[]; mimeType: string; audience?: number[] };
export type MessageData = { role: 1 | 2 | 3; name?: string; content: PartData[] };
export type ErrorData = { message: string; name: string; code?: string };
export type StreamItem = { done: boolean; value?: PartData; error?: ErrorData };

export function serializePart(part: unknown): PartData {
  if (part instanceof LanguageModelTextPart)
    return { type: "text", value: part.value, audience: part.audience };
  if (part instanceof LanguageModelThinkingPart)
    return { type: "thinking", value: part.value, id: part.id, metadata: part.metadata };
  if (part instanceof LanguageModelToolCallPart)
    return { type: "toolCall", callId: part.callId, name: part.name, input: part.input };
  if (part instanceof LanguageModelToolResultPart)
    return {
      type: "toolResult",
      callId: part.callId,
      content: part.content.map(serializePart),
      isError: part.isError,
    };
  if (part instanceof LanguageModelDataPart)
    return { type: "data", data: [...part.data], mimeType: part.mimeType, audience: part.audience };
  throw new TypeError("Unsupported language model content part");
}
export function revivePart(part: PartData): unknown {
  switch (part.type) {
    case "text":
      return new LanguageModelTextPart(part.value, part.audience);
    case "thinking":
      return new LanguageModelThinkingPart(part.value, part.id, part.metadata);
    case "toolCall":
      return new LanguageModelToolCallPart(part.callId, part.name, part.input);
    case "toolResult":
      return new LanguageModelToolResultPart(
        part.callId,
        part.content.map(revivePart),
        part.isError,
      );
    case "data":
      return new LanguageModelDataPart(Uint8Array.from(part.data), part.mimeType, part.audience);
  }
}
export function serializeMessage(message: {
  role: 1 | 2 | 3;
  content: readonly unknown[];
  name?: string;
}): MessageData {
  return { role: message.role, name: message.name, content: message.content.map(serializePart) };
}
export function reviveMessage(message: MessageData) {
  return new LanguageModelChatMessage(message.role, message.content.map(revivePart), message.name);
}
export function serializeModelError(error: unknown): ErrorData {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof LanguageModelError ? error.code : undefined,
  };
}
export function reviveModelError(error: ErrorData): Error {
  if (
    error.name === "Canceled" ||
    error.name === "AbortError" ||
    error.name === "CancellationError"
  )
    return new CancellationError();
  return error.code
    ? new LanguageModelError(error.message, error.code)
    : Object.assign(new Error(error.message), { name: error.name });
}
