import {
  ImageModality,
  PdfModality,
  TextModality,
  type LlmModelInfo,
  type Modality,
} from "@harness/llm";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_CONTEXT_WINDOW = 1_048_576;
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 256_000;

export interface DeepSeekModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean | readonly string[];
  readonly inputModalities?: readonly Modality[];
  readonly outputModalities?: readonly Modality[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly systemPromptUpdate?: "in-history" | "leading-only";
  readonly toolUpdate?: "in-history" | "addition-only";
}

export function deepseekOrigin(baseUrl: string = DEEPSEEK_DEFAULT_BASE_URL): string {
  return new URL(baseUrl).origin;
}

export function deepseekMessagesRoot(baseUrl: string = DEEPSEEK_DEFAULT_BASE_URL): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const pathname = new URL(trimmed).pathname;
  if (pathname.endsWith("/anthropic/v1")) {
    return trimmed;
  }
  if (pathname.endsWith("/anthropic")) {
    return `${trimmed}/v1`;
  }
  if (pathname.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/anthropic/v1`;
}

export const DEEPSEEK_DEFAULT_MODELS: readonly DeepSeekModelConfig[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    systemPromptUpdate: "in-history",
    toolUpdate: "addition-only",
    contextWindow: DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    reasoning: ["low", "high", "max"],
    inputModalities: [TextModality.create(), ImageModality.create(), PdfModality.create()],
    outputModalities: [TextModality.create()],
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    systemPromptUpdate: "leading-only",
    toolUpdate: "addition-only",
    contextWindow: DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    reasoning: ["low", "high", "max"],
    inputModalities: [TextModality.create()],
    outputModalities: [TextModality.create()],
  },
];

export function toDeepSeekModelInfo(providerId: string, config: DeepSeekModelConfig): LlmModelInfo {
  return {
    id: config.id,
    provider: providerId,
    name: config.name ?? config.id,
    reasoning: config.reasoning ?? ["low", "high", "max"],
    inputModalities: config.inputModalities ?? [TextModality.create()],
    outputModalities: config.outputModalities ?? [TextModality.create()],
    contextWindow: config.contextWindow ?? DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    systemPromptUpdate: config.systemPromptUpdate,
  };
}

export function mergeDeepSeekModels(
  discovered: readonly DeepSeekModelConfig[],
  configured: readonly DeepSeekModelConfig[],
): readonly DeepSeekModelConfig[] {
  if (discovered.length === 0) return configured;
  if (configured.length === 0) return discovered;

  const byId = new Map<string, DeepSeekModelConfig>();
  for (const item of configured) {
    byId.set(item.id, item);
  }

  const seen = new Set<string>();
  const out: DeepSeekModelConfig[] = [];
  for (const remote of discovered) {
    seen.add(remote.id);
    const local = byId.get(remote.id);
    if (local === undefined) {
      out.push(remote);
    } else {
      out.push({
        id: remote.id,
        name: local.name ?? remote.name,
        reasoning: local.reasoning ?? remote.reasoning,
        inputModalities: local.inputModalities ?? remote.inputModalities,
        outputModalities: local.outputModalities ?? remote.outputModalities,
        contextWindow: local.contextWindow ?? remote.contextWindow,
        maxTokens: local.maxTokens ?? remote.maxTokens,
        systemPromptUpdate: local.systemPromptUpdate ?? remote.systemPromptUpdate,
        toolUpdate: local.toolUpdate ?? remote.toolUpdate,
      });
    }
  }
  for (const local of configured) {
    if (!seen.has(local.id)) {
      out.push(local);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeepSeekModalities(raw: unknown): readonly Modality[] {
  if (!Array.isArray(raw)) {
    return [TextModality.create()];
  }
  const out: Modality[] = [];
  for (const item of raw) {
    if (item === "text") out.push(TextModality.create());
    else if (item === "image") out.push(ImageModality.create());
    else if (item === "pdf" || item === "document") out.push(PdfModality.create());
  }
  return out.length > 0 ? out : [TextModality.create()];
}

export function parseDeepSeekModelListing(body: unknown): readonly DeepSeekModelConfig[] {
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    throw new Error("DeepSeek model listing response has no 'data' array");
  }
  const models: DeepSeekModelConfig[] = [];
  const seen = new Set<string>();

  for (const row of body["data"]) {
    if (!isRecord(row) || typeof row["id"] !== "string" || !row["id"] || seen.has(row["id"])) {
      continue;
    }
    const id = row["id"];
    seen.add(id);

    const apiCapabilities = isRecord(row["api_capabilities"]) ? row["api_capabilities"] : undefined;
    const messagesCap =
      apiCapabilities && isRecord(apiCapabilities["anthropic_messages"])
        ? apiCapabilities["anthropic_messages"]
        : undefined;
    if (messagesCap === undefined) {
      continue;
    }

    const systemPromptUpdate =
      messagesCap["system_prompt_update"] === "in-history" ? "in-history" : "leading-only";
    const toolUpdate =
      messagesCap["tool_update"] === "in-history"
        ? "in-history"
        : messagesCap["tool_update"] === "addition-only"
          ? "addition-only"
          : undefined;

    const effortObj = isRecord(row["effort"]) ? row["effort"] : undefined;
    const supportedLevels =
      effortObj && Array.isArray(effortObj["supported_levels"])
        ? effortObj["supported_levels"].filter((x): x is string => typeof x === "string")
        : ["low", "high", "max"];

    const contextWindow =
      typeof row["context_window"] === "number" && row["context_window"] > 0
        ? row["context_window"]
        : DEEPSEEK_DEFAULT_CONTEXT_WINDOW;
    const maxOutputTokens =
      typeof row["max_output_tokens"] === "number" && row["max_output_tokens"] > 0
        ? Math.min(DEEPSEEK_DEFAULT_MAX_TOKENS, row["max_output_tokens"])
        : DEEPSEEK_DEFAULT_MAX_TOKENS;

    models.push({
      id,
      name: typeof row["name"] === "string" && row["name"] ? row["name"] : id,
      systemPromptUpdate,
      toolUpdate,
      contextWindow,
      maxTokens: maxOutputTokens,
      reasoning: supportedLevels.length > 0 ? supportedLevels : true,
      inputModalities: parseDeepSeekModalities(row["input_modalities"]),
      outputModalities: parseDeepSeekModalities(row["output_modalities"]),
    });
  }

  return models;
}
