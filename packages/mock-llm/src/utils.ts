import {
  AssistantMessage,
  ContentMessage,
  extractText,
  TextBlock,
  TextModality,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type ContentBlock,
  type LlmModelInfo,
  type LlmRequest,
  type LlmUsage,
  type Message,
} from "@harness/llm";
import { ExtensibleVariants } from "@harness/variants";
import { shallowRef, type ShallowRef } from "reactivity";
import type { MockChunkSize, MockModelConfig } from "./types.ts";

export const MOCK_DEFAULT_CONTEXT_WINDOW = 200_000;
export const MOCK_DEFAULT_MAX_TOKENS = 16_384;

export class MockLlmError extends Error {
  readonly retryable?: boolean;

  constructor(message: string, options?: { readonly retryable?: boolean }) {
    super(message);
    this.name = "MockLlmError";
    this.retryable = options?.retryable;
  }
}

export class MockAbortError extends Error {
  constructor(message: string = "Mock request aborted") {
    super(message);
    this.name = "MockAbortError";
  }
}

interface GateWaiter {
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
  readonly cleanup: () => void;
}

export class MockGate {
  private readonly _waitingCount: ShallowRef<number> = shallowRef(0);
  private readonly _waiters: GateWaiter[] = [];
  private _arrivalResolve: (() => void) | undefined;
  private _arrivalPromise: Promise<void> | undefined;

  get isWaiting(): boolean {
    return this._waitingCount.value > 0;
  }

  get waitCount(): number {
    return this._waitingCount.value;
  }

  get arrived(): Promise<void> {
    if (this._arrivalPromise === undefined) {
      this._arrivalPromise = new Promise<void>((resolve) => {
        this._arrivalResolve = resolve;
      });
      if (this._waiters.length > 0) {
        const res = this._arrivalResolve;
        this._arrivalResolve = undefined;
        res?.();
      }
    }
    return this._arrivalPromise;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new MockAbortError());
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this._waiters.indexOf(entry);
        if (idx >= 0) {
          this._waiters.splice(idx, 1);
          this._waitingCount.value = this._waiters.length;
        }
        reject(new MockAbortError());
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const entry: GateWaiter = { resolve, reject, cleanup };
      this._waiters.push(entry);
      this._waitingCount.value = this._waiters.length;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this._arrivalResolve !== undefined) {
        const res = this._arrivalResolve;
        this._arrivalResolve = undefined;
        res();
      }
    });
  }

  release(): void {
    const batch = this._waiters.splice(0);
    this._waitingCount.value = 0;
    this._arrivalPromise = undefined;
    this._arrivalResolve = undefined;
    for (const entry of batch) {
      entry.cleanup();
      entry.resolve();
    }
  }

  reject(error: unknown = new MockLlmError("Mock gate rejected")): void {
    const batch = this._waiters.splice(0);
    this._waitingCount.value = 0;
    this._arrivalPromise = undefined;
    this._arrivalResolve = undefined;
    for (const entry of batch) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new MockAbortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MockAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function waitUntilAborted(signal?: AbortSignal): Promise<never> {
  if (signal?.aborted) {
    return Promise.reject(new MockAbortError());
  }
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) {
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new MockAbortError());
      },
      { once: true },
    );
  });
}

export function sliceString(text: string, chunkSize: MockChunkSize): string[] {
  if (text.length === 0) {
    return [];
  }
  if (typeof chunkSize === "number") {
    const size = Math.floor(chunkSize);
    if (size <= 0 || size >= text.length) {
      return [text];
    }
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      out.push(text.slice(i, i + size));
    }
    return out;
  }

  const min = Math.max(1, Math.floor(chunkSize.min));
  const max = Math.max(min, Math.floor(chunkSize.max));
  const out: string[] = [];
  let offset = 0;
  let step = 0;
  while (offset < text.length) {
    const span = min === max ? min : min + ((step * 7 + text.charCodeAt(offset)) % (max - min + 1));
    out.push(text.slice(offset, offset + span));
    offset += span;
    step += 1;
  }
  return out;
}

export function extractRequestFacts(messages: readonly Message[]): {
  readonly lastUserText: string;
  readonly toolResults: readonly ToolResultMessage[];
  readonly allToolResults: readonly ToolResultMessage[];
} {
  let lastUserText = "";
  const allToolResults: ToolResultMessage[] = [];
  let trailingToolResults: ToolResultMessage[] = [];

  for (const msg of messages) {
    if (msg instanceof UserMessage) {
      lastUserText = extractText(msg.content);
      trailingToolResults = [];
    } else if (msg instanceof ToolResultMessage) {
      allToolResults.push(msg);
      trailingToolResults.push(msg);
    }
  }

  return {
    lastUserText,
    toolResults: trailingToolResults,
    allToolResults,
  };
}

export function findTranscriptProblems(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  const pendingToolIds = new Set<string>();
  const seenToolIds = new Set<string>();

  for (const msg of messages) {
    if (msg instanceof AssistantMessage) {
      if (pendingToolIds.size > 0) {
        problems.push(
          `assistant message arrived with unresolved tool calls: ${[...pendingToolIds].join(", ")}`,
        );
      }
      for (const block of msg.content) {
        if (block instanceof ToolCallBlock) {
          if (seenToolIds.has(block.id)) {
            problems.push(`duplicate tool call id '${block.id}'`);
          }
          seenToolIds.add(block.id);
          pendingToolIds.add(block.id);
        }
      }
    } else if (msg instanceof ToolResultMessage) {
      if (!pendingToolIds.delete(msg.toolCallId)) {
        problems.push(`orphan tool result for unknown or already resolved id '${msg.toolCallId}'`);
      }
    } else if (msg instanceof UserMessage && pendingToolIds.size > 0) {
      problems.push(
        `user message arrived with unresolved tool calls: ${[...pendingToolIds].join(", ")}`,
      );
    }
  }

  return problems;
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function serializePromptPrefixParts(request: LlmRequest): string[] {
  const parts: string[] = [];
  if (request.systemPrompt) {
    parts.push(`system:${request.systemPrompt}`);
  }
  if (request.tools && request.tools.length > 0) {
    parts.push(`tools:${JSON.stringify(request.tools)}`);
  }
  for (const msg of request.messages) {
    if (msg instanceof ContentMessage) {
      parts.push(JSON.stringify(ExtensibleVariants.serialize(msg)));
    }
  }
  return parts;
}

export function estimateUsage(
  request: LlmRequest,
  outputBlocks: readonly ContentBlock[],
  sessionPrefixCache: Map<string, readonly string[]>,
): LlmUsage {
  const promptParts = serializePromptPrefixParts(request);
  const promptChars = promptParts.reduce((sum, part) => sum + part.length, 0);
  const rawInputTokens = Math.max(1, estimateTokensFromChars(promptChars));

  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let inputTokens = rawInputTokens;

  if (request.sessionId !== undefined && request.sessionId.length > 0) {
    const previous = sessionPrefixCache.get(request.sessionId);
    if (previous !== undefined) {
      let commonChars = 0;
      const limit = Math.min(previous.length, promptParts.length);
      for (let i = 0; i < limit; i++) {
        if (previous[i] !== promptParts[i]) {
          break;
        }
        commonChars += promptParts[i]!.length;
      }
      const cached = estimateTokensFromChars(commonChars);
      if (cached > 0) {
        cacheReadTokens = Math.min(rawInputTokens, cached);
        inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
        if (inputTokens > 0) {
          cacheWriteTokens = inputTokens;
        }
      } else {
        cacheWriteTokens = rawInputTokens;
      }
    } else {
      cacheWriteTokens = rawInputTokens;
    }
    sessionPrefixCache.set(request.sessionId, promptParts);
  }

  let outputChars = 0;
  for (const block of outputBlocks) {
    if (block instanceof TextBlock) {
      outputChars += block.text.length;
    } else if (block instanceof ThinkingBlock) {
      outputChars += block.thinking.length;
    } else if (block instanceof ToolCallBlock) {
      outputChars += block.name.length + block.arguments.length + 8;
    }
  }
  const outputTokens = estimateTokensFromChars(outputChars);

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    totalTokens: inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
  };
}

export function isLlmModelInfo(item: MockModelConfig | LlmModelInfo): item is LlmModelInfo {
  return "provider" in item && typeof item.provider === "string";
}

export function toLlmModelInfo(
  providerId: string,
  config: MockModelConfig | LlmModelInfo,
  defaultContextWindow: number = MOCK_DEFAULT_CONTEXT_WINDOW,
  defaultMaxTokens: number = MOCK_DEFAULT_MAX_TOKENS,
): LlmModelInfo {
  if (isLlmModelInfo(config)) {
    return {
      ...config,
      provider: config.provider || providerId,
    };
  }
  return {
    id: config.id,
    provider: providerId,
    name: config.name ?? config.id,
    reasoning: config.reasoning ?? true,
    inputModalities: config.inputModalities ?? [TextModality.create()],
    outputModalities: config.outputModalities ?? [TextModality.create()],
    contextWindow: config.contextWindow ?? defaultContextWindow,
    maxTokens: config.maxTokens ?? defaultMaxTokens,
  };
}
