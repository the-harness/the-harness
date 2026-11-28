import { inject, onScopeDispose, optionalInject } from "@harness/di";
import {
  LlmService,
  TextBlock,
  UserMessage,
  type ContentBlock,
  type LlmModelInfo,
} from "@harness/llm";
import { SessionCatalog } from "@harness/session-catalog";
import { SessionDigest } from "@harness/session-digest";
import { SessionDigestStore } from "@harness/session-digest/node";

export type SessionTitleSource = "fallback" | "generated" | "custom";

export const sessionTitleField = SessionDigest.field<string>("sessionTitle");
export const sessionTitleSourceField = SessionDigest.field<SessionTitleSource>("sessionTitleSource");

const FALLBACK_MAX_CHARS = 42;
const MIN_LLM_INPUT_CHARS = 10;
const MAX_INPUT_CHARS = 1200;
const MAX_TITLE_CHARS = 100;
const MAX_OUTPUT_TOKENS = 128;
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = [
  "Generate a concise, single-line title for the user's request.",
  "Use the same language as the user's message.",
  "Aim for 3-7 words (or equivalent length in CJK).",
  "Preserve proper nouns, file names, and technical terms.",
  "Do not answer the request.",
  "Output only the plain-text title with no quotes, markdown, or trailing punctuation.",
].join(" ");

export class SessionTitleService {
  private readonly catalog = inject(SessionCatalog);
  private readonly llm = inject(LlmService);
  private readonly digestStore = optionalInject(SessionDigestStore);
  private readonly pending = new Map<string, AbortController>();
  private readonly pinned = new Set<string>();

  constructor() {
    onScopeDispose(() => {
      for (const controller of this.pending.values()) {
        controller.abort();
      }
      this.pending.clear();
    });
  }

  generateTitle(
    sessionId: string,
    input: string | readonly ContentBlock[],
    options?: { readonly signal?: AbortSignal },
  ): void {
    if (this.pinned.has(sessionId) || this.pending.has(sessionId)) return;
    const summary = this.catalog.get(sessionId);
    if (!summary || summary.title !== undefined) return;

    const normalized = normalizeInput(extractInputText(input));
    const fallback = buildFallbackTitle(normalized);
    this.applyTitle(sessionId, fallback, "fallback");

    if (options?.signal?.aborted) return;
    if (normalized.length < MIN_LLM_INPUT_CHARS) return;

    const model = this.resolveModel(summary.modelId);
    if (!model) return;

    void this.generateAsync(sessionId, normalized, model, options?.signal);
  }

  rename(sessionId: string, title: string): void {
    this.pinned.add(sessionId);
    this.abortPending(sessionId);
    this.applyTitle(sessionId, title, "custom");
  }

  private applyTitle(sessionId: string, title: string, source: SessionTitleSource): void {
    this.catalog.rename(sessionId, title);
    const digest = this.digestStore?.get(sessionId);
    if (digest) {
      digest.set(sessionTitleField, title);
      digest.set(sessionTitleSourceField, source);
    }
  }

  private resolveModel(modelId?: string): LlmModelInfo | undefined {
    const models = this.llm.models;
    if (modelId) {
      const matched = models.find((m) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
      if (matched) return matched;
    }
    return models[0];
  }

  private abortPending(sessionId: string): void {
    const existing = this.pending.get(sessionId);
    if (existing) {
      existing.abort();
      this.pending.delete(sessionId);
    }
  }

  private async generateAsync(
    sessionId: string,
    input: string,
    model: LlmModelInfo,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    this.pending.set(sessionId, controller);
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const reasoning = Array.isArray(model.reasoning)
        ? model.reasoning[0]
        : model.reasoning
          ? false
          : undefined;

      const stream = this.llm.stream({
        provider: model.provider,
        model: model.id,
        systemPrompt: SYSTEM_PROMPT,
        messages: [new UserMessage([new TextBlock(input.slice(0, MAX_INPUT_CHARS))])],
        tools: [],
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(reasoning !== undefined ? { reasoning } : {}),
        signal,
      });

      const response = await stream.result();
      if (signal.aborted || this.pinned.has(sessionId)) return;

      const raw = response.content
        .filter((block): block is TextBlock => block instanceof TextBlock)
        .map((block) => block.text)
        .join("");

      const cleaned = cleanGeneratedTitle(raw);
      if (!cleaned) return;

      if (!signal.aborted && !this.pinned.has(sessionId)) {
        this.applyTitle(sessionId, cleaned, "generated");
      }
    } catch {
      // Keep the fallback title on any LLM or abort error.
    } finally {
      clearTimeout(timeout);
      if (this.pending.get(sessionId) === controller) {
        this.pending.delete(sessionId);
      }
    }
  }
}

function extractInputText(input: string | readonly ContentBlock[]): string {
  if (typeof input === "string") return input;
  return input
    .filter((block): block is TextBlock => block instanceof TextBlock)
    .map((block) => block.text)
    .join(" ");
}

function normalizeInput(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function buildFallbackTitle(normalized: string): string {
  if (!normalized) return "Review attachments";
  if (normalized.length <= FALLBACK_MAX_CHARS) return normalized;
  return `${normalized.slice(0, FALLBACK_MAX_CHARS)}...`;
}

function cleanGeneratedTitle(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;

  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.?!。？！]+$/g, "")
    .trim();

  if (!cleaned) return undefined;
  if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_TITLE_CHARS)}...`;
}
