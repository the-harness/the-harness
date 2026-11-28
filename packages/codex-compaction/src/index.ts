import { SupplementaryField } from "@harness/agent-loop";
import {
  AssistantMessage,
  extractText,
  DeveloperMessage,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type LlmResponse,
  type LlmUsage,
  type Message,
} from "@harness/llm";
import {
  defaultIsContextOverflowError,
  PiCompactionService,
  useCompaction,
  type CompactionInput,
  type CompactionOptions,
} from "@harness/pi-compaction";
import { variant } from "@harness/variants";
import { onScopeDispose } from "reactivity";

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const DEFAULT_KEEP_RECENT_USER_TOKENS = 20000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function formatCodexSummary(summary: string): string {
  return `${SUMMARY_PREFIX}\n${summary}`;
}

@variant("core:codex-compaction:summary")
export class CodexCompactionSummaryMessage extends UserMessage {
  declare readonly from: number;
  declare readonly to: number;
  declare readonly summary?: string;
  declare readonly usage?: LlmUsage;
}

export interface CodexCompactionOptions {
  readonly baseInstructions?: () => string | undefined;
  readonly compactPrompt?: string;
  readonly keepRecentUserTokens?: number;
  readonly maxTokens?: number;
}

function isSummarizable(message: Message): boolean {
  return (
    message instanceof UserMessage ||
    message instanceof AssistantMessage ||
    message instanceof ToolResultMessage ||
    message instanceof DeveloperMessage
  );
}

function rebuildTextOnly(message: UserMessage, text: string): UserMessage {
  return UserMessage.create({
    id: message.id,
    content: [TextBlock.create({ text })],
  });
}

function truncateUserText(text: string, bytes: Uint8Array, maxTokens: number): string {
  const maxBytes = Math.floor(maxTokens) * 4;
  if (bytes.length <= maxBytes) return text;
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  let end = leftBudget;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  let start = bytes.length - rightBudget;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  const prefix = textDecoder.decode(bytes.subarray(0, end));
  const suffix = textDecoder.decode(bytes.subarray(start));
  // Codex charges the retained UTF-8 text, with the truncation marker outside that budget.
  const removedTokens = Math.ceil((bytes.length - maxBytes) / 4);
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function removeOldestMessage(messages: readonly Message[]): Message[] {
  const [oldest, ...remaining] = messages;
  if (!(oldest instanceof AssistantMessage)) return remaining;
  const callIds = new Set(
    oldest.content.filter((block) => block instanceof ToolCallBlock).map((block) => block.id),
  );
  return remaining.filter(
    (message) => !(message instanceof ToolResultMessage && callIds.has(message.toolCallId)),
  );
}

export class CodexCompactionService extends PiCompactionService {
  readonly #baseInstructions: (() => string | undefined) | undefined;
  readonly #compactPrompt: string;
  readonly #keepRecentUserTokens: number;
  readonly #lifetime = new AbortController();

  constructor(options: CodexCompactionOptions = {}) {
    super();
    this.#baseInstructions = options.baseInstructions;
    this.#compactPrompt = options.compactPrompt ?? SUMMARIZATION_PROMPT;
    this.#keepRecentUserTokens = options.keepRecentUserTokens ?? DEFAULT_KEEP_RECENT_USER_TOKENS;
    onScopeDispose(() => this.#lifetime.abort());
  }

  protected override async defaultSummarize(
    messages: readonly Message[],
    options?: CompactionOptions & { readonly throughIndex: number },
  ): Promise<Message> {
    const { provider, model } = this.modelSelection.current;
    const lifetime = this.#lifetime.signal;
    const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    const systemPrompt = this.#baseInstructions?.();
    let input = [
      ...messages,
      UserMessage.create({ content: [TextBlock.create({ text: this.#compactPrompt })] }),
    ];
    let response: LlmResponse;
    for (;;) {
      signal.throwIfAborted();
      try {
        const stream = this.llm.stream({ provider, model, signal, systemPrompt, messages: input });
        for await (const _chunk of stream) {
          // The provider produces chunks lazily, and result() only settles once the stream runs.
        }
        response = await stream.result();
        signal.throwIfAborted();
        if (response.stopReason === "error") {
          throw new Error(
            response.error?.message ?? "The model did not produce a compaction summary",
          );
        }
        break;
      } catch (error) {
        signal.throwIfAborted();
        const message =
          error instanceof Error ? error.message : typeof error === "string" ? error : "";
        if (input.length <= 1 || !defaultIsContextOverflowError(message)) throw error;
        input = removeOldestMessage(input);
      }
    }
    const summary = extractText(response.message.content).trim();
    if (response.stopReason !== "stop" || summary.length === 0) {
      throw new Error(
        response.error?.message ?? "The model did not produce a complete compaction summary",
      );
    }
    return CodexCompactionSummaryMessage.create({
      from: 0,
      to: options?.throughIndex ?? 0,
      summary,
      usage: response.usage,
      content: [TextBlock.create({ text: formatCodexSummary(summary) })],
    });
  }

  protected override summarize(input: CompactionInput): Promise<readonly Message[]> {
    return this.hooks.compact.run(input, async (input) => {
      const messages = input.messages.filter(isSummarizable);
      const summary = await this.defaultSummarize(messages, input);
      return [...this.#retainedUserMessages(messages), summary];
    });
  }

  protected override findCutPoint(
    upToIndex: number = this.context.batchCount - 1,
  ): Promise<number> {
    return Promise.resolve(upToIndex);
  }

  #retainedUserMessages(messages: readonly Message[]): UserMessage[] {
    const retained: UserMessage[] = [];
    let remaining = this.#keepRecentUserTokens;
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
      const message = messages[index]!;
      if (!(message instanceof UserMessage)) continue;
      if (message.meta.get(SupplementaryField) === true) continue;
      const text = extractText(message.content);
      if (text.startsWith(`${SUMMARY_PREFIX}\n`)) continue;
      const bytes = textEncoder.encode(text);
      retained.push(rebuildTextOnly(message, truncateUserText(text, bytes, remaining)));
      remaining = Math.max(remaining - Math.ceil(bytes.length / 4), 0);
    }
    return retained.reverse();
  }
}

export function useCodexCompaction(options: CodexCompactionOptions = {}): void {
  useCompaction({ maxTokens: options.maxTokens, keepRecentTokens: 0, backgroundTokens: 0 });
}
