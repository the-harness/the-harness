import { AuthService } from "@harness/auth";
import { CurrentScope, inject, optionalInject } from "@harness/di";
import { FileService } from "@harness/files";
import {
  AssistantMessage,
  DeveloperMessage,
  DocumentBlock,
  extractText,
  ImageBlock,
  ImageModality,
  LlmProvider,
  MediaBlock,
  PdfModality,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  FunctionToolDeclaration,
  type ContentBlock,
  type LlmChunk,
  type LlmModelInfo,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmStream,
  type LlmUsage,
  type Message,
  type ToolDeclaration,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResultItem,
} from "@harness/llm";
import {
  computed,
  onScopeDispose,
  shallowRef,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from "reactivity";
import {
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MODELS,
  deepseekMessagesRoot,
  deepseekOrigin,
  mergeDeepSeekModels,
  parseDeepSeekModelListing,
  toDeepSeekModelInfo,
  type DeepSeekModelConfig,
} from "./catalog.ts";
import { DEEPSEEK_FILES_BETA, DeepSeekFileService } from "./files.ts";
import { DeepSeekWebService } from "./web.ts";

export interface DeepSeekLlmProviderOptions {
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: MaybeRefOrGetter<readonly DeepSeekModelConfig[]>;
  readonly catalogRefreshIntervalMs?: number;
  readonly preferFilesApi?: boolean;
  readonly defaultReasoningEffort?: "off" | "low" | "high" | "max";
  readonly fetch?: typeof fetch;
}

interface WireInputBlock {
  readonly type: "text" | "image" | "document";
  readonly text?: string;
  readonly source?:
    | { readonly type: "base64"; readonly media_type: string; readonly data: string }
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "file"; readonly file_id: string };
}

type WireBlock =
  | WireInputBlock
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: readonly WireInputBlock[];
      readonly is_error?: boolean;
    };

interface WireMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: WireBlock[];
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function extractStaleFileId(errorText: string): string | undefined {
  const match = /file[-_][a-zA-Z0-9_-]+/.exec(errorText);
  return match?.[0];
}

function serializeTools(tools: readonly ToolDeclaration[] | undefined): unknown[] | undefined {
  const functions = tools?.filter((tool) => tool instanceof FunctionToolDeclaration);
  if (!functions || functions.length === 0) return undefined;
  return functions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

async function parseSseEvents(
  body: ReadableStream<Uint8Array>,
): Promise<AsyncIterable<Record<string, unknown>>> {
  const decoder = new TextDecoderStream() as TransformStream<Uint8Array, string>;
  const reader = body.pipeThrough(decoder).getReader();
  return {
    async *[Symbol.asyncIterator]() {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          let boundaryIndex: number;
          while ((boundaryIndex = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);
            const dataLines: string[] = [];
            for (const line of rawFrame.split(/\r?\n/)) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length === 0) continue;
            const dataStr = dataLines.join("\n");
            if (dataStr === "[DONE]") continue;
            const parsed = JSON.parse(dataStr) as Record<string, unknown>;
            yield parsed;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

export class DeepSeekLlmProvider extends LlmProvider implements WebSearchProvider {
  readonly options: DeepSeekLlmProviderOptions;

  protected readonly currentScope = inject(CurrentScope);
  protected readonly auth = optionalInject(AuthService);
  protected readonly fileService = optionalInject(FileService);
  protected readonly webService = optionalInject(DeepSeekWebService);
  protected readonly catalogModels: ShallowRef<readonly DeepSeekModelConfig[] | undefined> =
    shallowRef(undefined);
  protected readonly modelConfigs: ComputedRef<readonly DeepSeekModelConfig[]> = computed(() => {
    const configured =
      this.options.models !== undefined ? toValue(this.options.models) : DEEPSEEK_DEFAULT_MODELS;
    const discovered = this.catalogModels.value;
    return discovered === undefined ? configured : mergeDeepSeekModels(discovered, configured);
  });
  protected readonly resolvedModels: ComputedRef<readonly LlmModelInfo[]> = computed(() => {
    const providerId = this.currentScope.id;
    return this.modelConfigs.value.map((config) => toDeepSeekModelInfo(providerId, config));
  });

  constructor(options: DeepSeekLlmProviderOptions = {}) {
    super();
    this.options = options;
    const interval = options.catalogRefreshIntervalMs;
    if (interval !== undefined && interval > 0) {
      const timer = setInterval(() => {
        this.refreshCatalog().catch(() => {});
      }, interval);
      onScopeDispose(() => {
        clearInterval(timer);
      });
    }
  }

  override get models(): readonly LlmModelInfo[] {
    return this.resolvedModels.value;
  }

  async refreshCatalog(signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const url = `${deepseekOrigin(this.options.baseUrl)}/models`;
    const response = await this.authorizedFetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek /models failed with HTTP ${response.status}`);
    }
    this.catalogModels.value = parseDeepSeekModelListing(await response.json());
    return this.models;
  }

  async webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]> {
    const web = this.webService;
    if (web === undefined) {
      throw new Error("DeepSeek web search is unavailable");
    }
    const results = await web.search({ query: request.query, signal: request.signal });
    return results.map(({ url, title, snippet }) => ({ url, title, snippet }));
  }

  override stream(request: LlmRequest): LlmStream {
    const config =
      this.modelConfigs.value.find((model) => model.id === request.model) ??
      DEEPSEEK_DEFAULT_MODELS.find((model) => model.id === request.model);
    let settleResult!: (res: LlmResponse) => void;
    let rejectResult!: (err: unknown) => void;
    const resultPromise = new Promise<LlmResponse>((resolve, reject) => {
      settleResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});

    const generator = this.runMessagesStream(request, config, settleResult, rejectResult);

    return {
      result: () => resultPromise,
      [Symbol.asyncIterator]() {
        return generator;
      },
    };
  }

  protected async *runMessagesStream(
    request: LlmRequest,
    config: DeepSeekModelConfig | undefined,
    settleResult: (res: LlmResponse) => void,
    rejectResult: (err: unknown) => void,
  ): AsyncGenerator<LlmChunk> {
    let settled = false;
    try {
      if (config === undefined) {
        throw new Error(`unknown DeepSeek model '${request.model}'`);
      }

      const preferFiles = this.options.preferFilesApi !== false && this.fileService !== undefined;
      let useInlineFallback = !preferFiles;

      for (let attempt = 0; attempt < 2; attempt++) {
        const { messages, historySystem, usedFileIds } = await this.buildWireMessages(
          request.messages,
          config,
          !useInlineFallback,
          request.signal,
        );

        const system = [request.systemPrompt, historySystem].filter(Boolean).join("\n\n");
        const effort = this.resolveReasoningEffort(request.reasoning);
        const tools = serializeTools(request.tools);

        const body: Record<string, unknown> = {
          model: config.id,
          stream: true,
          max_tokens: request.maxTokens ?? config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
          messages,
          thinking: { type: effort === "off" ? "disabled" : "enabled" },
          ...(effort === "off" ? {} : { output_config: { effort } }),
          ...(system.length > 0 ? { system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(tools !== undefined ? { tools } : {}),
        };

        const root = deepseekMessagesRoot(this.options.baseUrl);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version": "2023-06-01",
          ...(usedFileIds ? { "anthropic-beta": DEEPSEEK_FILES_BETA } : {}),
        };

        const response = await this.authorizedFetch(`${root}/messages`, {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          if (attempt === 0 && usedFileIds && this.fileService instanceof DeepSeekFileService) {
            const staleId = extractStaleFileId(errorText);
            if (staleId !== undefined) {
              this.fileService.invalidate(staleId);
              continue;
            }
          }
          throw new Error(`DeepSeek Messages HTTP ${response.status}: ${errorText}`);
        }

        if (response.body === null) {
          throw new Error("DeepSeek Messages returned an empty response body");
        }

        const events = await parseSseEvents(response.body);
        const usage: LlmUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        const contentBlocks: ContentBlock[] = [];
        const activeBlocks = new Map<
          number,
          | { type: "text"; text: string }
          | { type: "thinking"; thinking: string; signature?: string }
          | { type: "tool_use"; id: string; name: string; json: string }
        >();
        let stopReason: LlmStopReason = "stop";

        for await (const event of events) {
          const eventType = event["type"];
          if (eventType === "message_start") {
            const msg = event["message"] as Record<string, unknown> | undefined;
            const rawUsage = msg?.["usage"] as Record<string, unknown> | undefined;
            if (rawUsage) {
              this.applyUsage(usage, rawUsage);
            }
          } else if (eventType === "content_block_start") {
            const idx = Number(event["index"] ?? activeBlocks.size);
            const block = event["content_block"] as Record<string, unknown> | undefined;
            if (!block) continue;
            const blockType = block["type"];
            if (blockType === "text") {
              const initialText = typeof block["text"] === "string" ? block["text"] : "";
              activeBlocks.set(idx, { type: "text", text: initialText });
              if (initialText) {
                yield { type: "text_delta", delta: initialText };
              }
            } else if (blockType === "thinking") {
              const initialThinking =
                typeof block["thinking"] === "string" ? block["thinking"] : "";
              const sig = typeof block["signature"] === "string" ? block["signature"] : undefined;
              activeBlocks.set(idx, {
                type: "thinking",
                thinking: initialThinking,
                signature: sig,
              });
              if (initialThinking) {
                yield { type: "thinking_delta", delta: initialThinking };
              }
            } else if (blockType === "tool_use") {
              const id = String(block["id"] ?? "");
              const name = String(block["name"] ?? "");
              activeBlocks.set(idx, { type: "tool_use", id, name, json: "" });
              yield { type: "tool_call_start", id, name };
            }
          } else if (eventType === "content_block_delta") {
            const idx = Number(event["index"] ?? 0);
            const active = activeBlocks.get(idx);
            const delta = event["delta"] as Record<string, unknown> | undefined;
            if (!active || !delta) continue;
            const deltaType = delta["type"];
            if (deltaType === "text_delta" && active.type === "text") {
              const chunk = String(delta["text"] ?? "");
              active.text += chunk;
              yield { type: "text_delta", delta: chunk };
            } else if (deltaType === "thinking_delta" && active.type === "thinking") {
              const chunk = String(delta["thinking"] ?? "");
              active.thinking += chunk;
              yield { type: "thinking_delta", delta: chunk };
            } else if (deltaType === "signature_delta" && active.type === "thinking") {
              active.signature = (active.signature ?? "") + String(delta["signature"] ?? "");
            } else if (deltaType === "input_json_delta" && active.type === "tool_use") {
              const chunk = String(delta["partial_json"] ?? "");
              active.json += chunk;
              yield { type: "tool_call_delta", id: active.id, delta: chunk };
            }
          } else if (eventType === "content_block_stop") {
            const idx = Number(event["index"] ?? 0);
            const active = activeBlocks.get(idx);
            if (!active) continue;
            if (active.type === "text") {
              contentBlocks.push(TextBlock.create({ text: active.text }));
            } else if (active.type === "thinking") {
              contentBlocks.push(
                ThinkingBlock.create({
                  thinking: active.thinking,
                  signature: active.signature,
                }),
              );
            } else if (active.type === "tool_use") {
              const args = active.json || "{}";
              contentBlocks.push(
                ToolCallBlock.create({
                  id: active.id,
                  name: active.name,
                  arguments: args,
                }),
              );
              yield {
                type: "tool_call_end",
                id: active.id,
                name: active.name,
                arguments: args,
              };
            }
          } else if (eventType === "message_delta") {
            const delta = event["delta"] as Record<string, unknown> | undefined;
            const rawStop = delta?.["stop_reason"];
            if (rawStop === "tool_use") stopReason = "tool_calls";
            else if (rawStop === "max_tokens") stopReason = "max_tokens";
            else if (rawStop === "refusal") stopReason = "error";
            else if (rawStop === "end_turn" || rawStop === "stop_sequence") stopReason = "stop";
            const rawUsage = event["usage"] as Record<string, unknown> | undefined;
            if (rawUsage) {
              this.applyUsage(usage, rawUsage);
            }
          }
        }

        const finalUsage: LlmUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          totalTokens:
            usage.inputTokens +
            usage.outputTokens +
            (usage.cacheReadTokens ?? 0) +
            (usage.cacheWriteTokens ?? 0),
        };

        const finalResponse: LlmResponse = {
          message: AssistantMessage.create({
            content: contentBlocks,
            provider: request.provider,
            model: request.model,
            replayState: { kind: "deepseek-messages", model: request.model },
          }),
          stopReason,
          usage: finalUsage,
          ...(stopReason === "error"
            ? { error: { message: "DeepSeek refused to answer under content safety review" } }
            : {}),
        };

        settled = true;
        settleResult(finalResponse);
        yield { type: "finish", response: finalResponse };
        return;
      }
    } catch (error) {
      const isAborted = Boolean(request.signal?.aborted);
      const errResponse: LlmResponse = {
        message: AssistantMessage.create({
          content: [],
          provider: request.provider,
          model: request.model,
        }),
        stopReason: isAborted ? "aborted" : "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
      settled = true;
      settleResult(errResponse);
      rejectResult(error);
      yield { type: "finish", response: errResponse };
    } finally {
      if (!settled) {
        settleResult({
          message: AssistantMessage.create({
            content: [],
            provider: request.provider,
            model: request.model,
          }),
          stopReason: "aborted",
        });
      }
    }
  }

  protected applyUsage(target: LlmUsage, raw: Record<string, unknown>): void {
    const mutable = target as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    if (typeof raw["input_tokens"] === "number") {
      mutable.inputTokens = raw["input_tokens"];
    }
    if (typeof raw["output_tokens"] === "number") {
      mutable.outputTokens = raw["output_tokens"];
    }
    if (typeof raw["cache_read_input_tokens"] === "number" && raw["cache_read_input_tokens"] > 0) {
      mutable.cacheReadTokens = raw["cache_read_input_tokens"];
    }
    if (
      typeof raw["cache_creation_input_tokens"] === "number" &&
      raw["cache_creation_input_tokens"] > 0
    ) {
      mutable.cacheWriteTokens = raw["cache_creation_input_tokens"];
    }
  }

  protected resolveReasoningEffort(
    reasoning: LlmRequest["reasoning"],
  ): "off" | "low" | "high" | "max" {
    if (reasoning === false || reasoning === "off") {
      return "off";
    }
    if (reasoning === "low" || reasoning === "minimal") {
      return "low";
    }
    if (reasoning === "max" || reasoning === "xhigh") {
      return "max";
    }
    if (
      reasoning === "high" ||
      reasoning === "medium" ||
      reasoning === true ||
      reasoning === "on"
    ) {
      return "high";
    }
    return this.options.defaultReasoningEffort ?? "high";
  }

  protected async buildWireMessages(
    history: readonly Message[],
    config: DeepSeekModelConfig,
    useFilesApi: boolean,
    signal?: AbortSignal,
  ): Promise<{
    readonly messages: WireMessage[];
    readonly historySystem: string | undefined;
    readonly usedFileIds: boolean;
  }> {
    const inHistory = config.systemPromptUpdate === "in-history";
    const modalities = config.inputModalities ?? [];
    const acceptsImage = modalities.some((m) => m instanceof ImageModality);
    const acceptsPdf = modalities.some((m) => m instanceof PdfModality);
    let usedFileIds = false;

    const toInputBlocks = async (blocks: readonly ContentBlock[]): Promise<WireInputBlock[]> => {
      const out: WireInputBlock[] = [];
      for (const block of blocks) {
        if (block instanceof TextBlock) {
          if (block.text.length > 0) {
            out.push({ type: "text", text: block.text });
          }
        } else if (
          (block instanceof ImageBlock && acceptsImage) ||
          (block instanceof DocumentBlock && acceptsPdf)
        ) {
          const wireKind = block instanceof ImageBlock ? "image" : "document";
          if (block.fileId !== undefined) {
            usedFileIds = true;
            out.push({
              type: wireKind,
              source: { type: "file", file_id: block.fileId },
            });
          } else if (block.data !== undefined && useFilesApi && this.fileService !== undefined) {
            try {
              const purpose =
                block instanceof DocumentBlock
                  ? (block.purpose ?? "rich_layout_recognition")
                  : "user_data";
              const uploaded = await this.fileService.upload({
                data: base64ToUint8Array(block.data),
                filename: block.filename ?? (wireKind === "image" ? "image.png" : "document.pdf"),
                mimeType: block.mimeType,
                purpose,
                signal,
              });
              usedFileIds = true;
              out.push({
                type: wireKind,
                source: { type: "file", file_id: uploaded.fileId },
              });
            } catch {
              out.push({
                type: wireKind,
                source: { type: "base64", media_type: block.mimeType, data: block.data },
              });
            }
          } else if (block.data !== undefined) {
            out.push({
              type: wireKind,
              source: { type: "base64", media_type: block.mimeType, data: block.data },
            });
          } else if (block.url !== undefined) {
            out.push({
              type: wireKind,
              source: { type: "url", url: block.url },
            });
          }
        } else if (block instanceof MediaBlock) {
          const ref = block.fileId ?? block.url ?? block.filename ?? block.mimeType;
          out.push({ type: "text", text: `[media: ${ref}]` });
        }
      }
      return out;
    };

    const messages: WireMessage[] = [];
    let historySystem: string | undefined;
    const systemUpdates: WireMessage[] = [];

    const flushSystemUpdates = () => {
      if (systemUpdates.length === 0) return;
      if (messages.at(-1)?.role === "user") {
        messages.push(...systemUpdates.splice(0));
      }
    };

    for (const msg of history) {
      if (msg instanceof DeveloperMessage) {
        const text = extractText(msg.content).trim();
        if (text.length > 0) {
          systemUpdates.push({ role: "system", content: [{ type: "text", text }] });
        }
        continue;
      }
      if (msg instanceof SystemMessage) {
        const text = extractText(msg.content);
        if (inHistory) {
          systemUpdates.push({ role: "system", content: text ? [{ type: "text", text }] : [] });
        } else if (text) {
          historySystem = [historySystem, text].filter(Boolean).join("\n\n");
        }
        continue;
      }
      if (msg instanceof AssistantMessage) {
        const blocks: WireBlock[] = [];
        const sameProviderAndModel =
          msg.provider === this.currentScope.id && msg.model === config.id;
        for (const block of msg.content) {
          if (block instanceof TextBlock && block.text.length > 0) {
            blocks.push({ type: "text", text: block.text });
          } else if (block instanceof ThinkingBlock) {
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              ...(sameProviderAndModel && block.signature !== undefined
                ? { signature: block.signature }
                : {}),
            });
          } else if (block instanceof ToolCallBlock) {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: parseJsonObject(block.arguments),
            });
          }
        }
        if (blocks.length === 0) continue;
        flushSystemUpdates();
        const prev = messages.at(-1);
        if (prev?.role === "assistant") {
          prev.content.push(...blocks);
        } else {
          messages.push({ role: "assistant", content: blocks });
        }
      } else if (msg instanceof ToolResultMessage) {
        const inputContent = await toInputBlocks(msg.content);
        const block: WireBlock = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: inputContent,
          ...(msg.isError !== undefined ? { is_error: msg.isError } : {}),
        };
        const prev = messages.at(-1);
        if (prev?.role === "user") {
          prev.content.push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      } else if (msg instanceof UserMessage) {
        const inputContent = await toInputBlocks(msg.content);
        if (inputContent.length === 0) continue;
        const prev = messages.at(-1);
        if (prev?.role === "user") {
          prev.content.push(...inputContent);
        } else {
          messages.push({ role: "user", content: [...inputContent] });
        }
      }
    }

    flushSystemUpdates();
    return { messages, historySystem, usedFileIds };
  }

  protected async authorizedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const baseFetch = this.options.fetch ?? globalThis.fetch;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authResult =
      this.auth !== undefined
        ? await this.auth.authorize({
            url,
            method: init?.method ?? "GET",
            signal: init?.signal ?? undefined,
          })
        : undefined;
    const headers = new Headers(this.options.headers);
    if (authResult !== undefined) {
      for (const [k, v] of Object.entries(authResult.headers)) {
        headers.set(k, v);
      }
    }
    if (init?.headers !== undefined) {
      const initHeaders = new Headers(init.headers);
      initHeaders.forEach((v, k) => {
        headers.set(k, v);
      });
    }
    return baseFetch(input, { ...init, headers });
  }
}
