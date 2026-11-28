import { ExtensibleVariants, variant } from "@harness/variants";
import type { AssistantMessage, Message } from "./message.ts";

export abstract class ToolDeclaration extends ExtensibleVariants {
  declare readonly name: string;
  declare readonly description: string;
}

export interface ToolGrammar {
  readonly syntax: string;
  readonly definition: string;
}

@variant("core:llm:tool:function")
export class FunctionToolDeclaration extends ToolDeclaration {
  declare readonly parameters: Record<string, unknown>;
}

@variant("core:llm:tool:freeform")
export class FreeformToolDeclaration extends ToolDeclaration {
  declare readonly grammar?: ToolGrammar;
}

export abstract class Modality extends ExtensibleVariants {}

@variant("core:llm:modality:text")
export class TextModality extends Modality {}

@variant("core:llm:modality:image")
export class ImageModality extends Modality {
  declare readonly maxCountPerRequest?: number;
  declare readonly maxBytesPerItem?: number;
}

@variant("core:llm:modality:video")
export class VideoModality extends Modality {
  declare readonly maxCountPerRequest?: number;
  declare readonly maxBytesPerItem?: number;
  declare readonly maxDurationMs?: number;
}

@variant("core:llm:modality:audio")
export class AudioModality extends Modality {
  declare readonly maxCountPerRequest?: number;
  declare readonly maxBytesPerItem?: number;
  declare readonly maxDurationMs?: number;
}

@variant("core:llm:modality:pdf")
export class PdfModality extends Modality {
  declare readonly maxCountPerRequest?: number;
  declare readonly maxBytesPerItem?: number;
  declare readonly maxPages?: number;
}

export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Message[];
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDeclaration[];
  readonly reasoning?: boolean | string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export interface WebSearchRequest {
  readonly provider: string;
  readonly query: string;
  readonly signal?: AbortSignal;
}

export interface WebSearchResultItem {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

// Extensible: provider packages implement this interface to serve hosted web search.
export interface WebSearchProvider {
  webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]>;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens: number;
}

export type LlmStopReason = "stop" | "tool_calls" | "max_tokens" | "aborted" | "error";

export interface LlmError {
  readonly message: string;
  readonly retryable?: boolean;
}

export interface LlmResponse {
  readonly message: AssistantMessage;
  readonly stopReason: LlmStopReason;
  readonly usage?: LlmUsage;
  readonly error?: LlmError;
}

export type LlmChunk =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly delta: string }
  | {
      readonly type: "tool_call_end";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "finish"; readonly response: LlmResponse };

export interface LlmStream extends AsyncIterable<LlmChunk> {
  result(): Promise<LlmResponse>;
}

export interface LlmModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly reasoning: boolean | readonly string[];
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** 该模型 wire 原生接受的 freeform grammar 语法；缺省表示只能收 function 工具。 */
  readonly freeformSyntaxes?: readonly string[];
  readonly systemPromptUpdate?: "in-history" | "leading-only";
}
