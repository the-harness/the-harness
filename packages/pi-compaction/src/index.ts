import { AgentLoop, RunStopMessage } from "@harness/agent-loop";
import { BatchMeta, Context, type ContextBatch } from "@harness/context";
import { ContextSizeService } from "@harness/context-size";
import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import {
  AssistantMessage,
  DeveloperMessage,
  extractText,
  LlmService,
  Message,
  snapshotSystemPrompt,
  SystemMessage,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type LlmUsage,
} from "@harness/llm";
import { ModelSelectionService } from "@harness/model-selection";
import { variant } from "@harness/variants";
import { onScopeDispose } from "reactivity";

@variant("core:compaction:summary")
export class CompactionSummaryMessage extends UserMessage {
  declare readonly from: number;
  declare readonly to: number;
  declare readonly summary?: string;
  declare readonly usage?: LlmUsage;
}

export interface CompactionSlice {
  readonly from: number;
  readonly to: number;
  readonly systemMessages: readonly SystemMessage[];
  readonly messages: readonly Message[];
}

export const CompactionSliceField = BatchMeta.defineField<CompactionSlice, typeof BatchMeta>(
  "core:compaction:slice",
);

export interface CompactionOptions {
  readonly signal?: AbortSignal;
  readonly customInstructions?: string;
  readonly reason?: "manual" | "threshold" | "overflow";
}

export interface CompactionInput extends CompactionOptions {
  readonly messages: readonly Message[];
  readonly throughIndex: number;
}

/** Extensible. */
export interface CompactionHooks {
  readonly run: HookSlot<CompactionInput, Promise<CompactionSlice | undefined>>;
  readonly compact: HookSlot<CompactionInput, Promise<readonly Message[]>>;
}

export interface UseCompactionOptions {
  readonly maxTokens?: number;
  readonly keepRecentTokens?: number;
  readonly backgroundTokens?: number;
  readonly isContextOverflowError?: (errorMessage: string) => boolean;
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_\s-]?length/i,
  /context[_\s-]?window/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many tokens/i,
  /token limit/i,
];

export function defaultIsContextOverflowError(errorMessage: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

function sanitizeTailMessages(messages: readonly Message[]): Message[] {
  const systemMessages: Message[] = [];
  let start = 0;
  while (start < messages.length) {
    const message = messages[start]!;
    if (message instanceof SystemMessage) {
      systemMessages.push(message);
    } else if (!(message instanceof ToolResultMessage)) {
      break;
    }
    start += 1;
  }
  const sliced = messages.slice(start);
  if (sliced.length > 0 && sliced[0] instanceof AssistantMessage) {
    const first = sliced[0];
    const resolvedIds = new Set<string>();
    for (let i = 1; i < sliced.length; i++) {
      const msg = sliced[i]!;
      if (msg instanceof AssistantMessage) break;
      if (msg instanceof ToolResultMessage) {
        resolvedIds.add(msg.toolCallId);
      }
    }
    const filteredContent = first.content.filter(
      (block) => !(block instanceof ToolCallBlock) || resolvedIds.has(block.id),
    );
    if (filteredContent.length === 0) {
      return [...systemMessages, ...sliced.slice(1)];
    }
    if (filteredContent.length !== first.content.length) {
      const nextFirst = Object.create(Object.getPrototypeOf(first)) as AssistantMessage;
      Object.assign(nextFirst, first, { content: filteredContent });
      sliced[0] = nextFirst;
    }
  }
  return [...systemMessages, ...sliced];
}

interface ActiveWindow {
  readonly slice: CompactionSlice | undefined;
  readonly tailBatches: readonly ContextBatch[];
}

class IncompleteCompactionSummaryError extends Error {}

export class PiCompactionService {
  readonly hooks: CompactionHooks = {
    run: new HookSlot<CompactionInput, Promise<CompactionSlice | undefined>>(),
    compact: new HookSlot<CompactionInput, Promise<readonly Message[]>>(),
  };

  protected readonly context = inject(Context);
  protected readonly contextSize = inject(ContextSizeService);
  protected readonly llm = inject(LlmService);
  protected readonly modelSelection = inject(ModelSelectionService);
  private readonly lifetime = new AbortController();
  keepRecentTokens = 20000;
  autoEnabled = true;
  maxActiveTokens: number | undefined = undefined;
  backgroundTokens: number | undefined = undefined;
  protected pendingCompaction: Promise<CompactionSlice | undefined> | undefined;

  constructor() {
    onScopeDispose(() => this.lifetime.abort());
  }

  protected async defaultSummarize(
    messages: readonly Message[],
    options?: CompactionOptions & { readonly throughIndex: number },
  ): Promise<Message> {
    const { provider, model } = this.modelSelection.current;
    const prompt = "Summarize the conversation above into a structured handoff summary.";
    const instructions = options?.customInstructions?.trim();
    const lifetime = this.lifetime.signal;
    const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    const stream = this.llm.stream({
      provider,
      model,
      signal,
      systemPrompt:
        "You are a context summarization assistant. Summarize the conversation concisely, preserving key decisions, goals, file paths, and current progress.",
      messages: [
        ...messages,
        UserMessage.create({
          content: [
            TextBlock.create({
              text: instructions
                ? `${prompt}\n\nAdditional instructions:\n${instructions}`
                : prompt,
            }),
          ],
        }),
      ],
    });
    // The provider produces chunks lazily, and result() only settles once the stream runs.
    for await (const _chunk of stream) {
      // Drain the stream; the finalized response is returned by result().
    }
    const response = await stream.result();
    signal.throwIfAborted();
    const summary = extractText(response.message.content).trim();
    if (response.stopReason !== "stop" || summary.length === 0) {
      throw new IncompleteCompactionSummaryError(
        response.error?.message ?? "The model did not produce a complete compaction summary",
      );
    }
    return CompactionSummaryMessage.create({
      from: 0,
      to: options?.throughIndex ?? 0,
      summary,
      usage: response.usage,
      content: [TextBlock.create({ text: this.formatCompactionSummary(summary) })],
    });
  }

  async latestSlice(
    upToIndex: number = this.context.batchCount - 1,
  ): Promise<CompactionSlice | undefined> {
    const { slice } = await this.readActiveWindow(upToIndex);
    return slice;
  }

  async estimateActiveSize(upToIndex: number = this.context.batchCount - 1): Promise<number> {
    const { slice, tailBatches } = await this.readActiveWindow(upToIndex);
    let total = 0;
    if (slice !== undefined) {
      for (const sys of slice.systemMessages) {
        total += this.contextSize.sizeOf(sys);
      }
      for (const msg of slice.messages) {
        total += this.contextSize.sizeOf(msg);
      }
    }
    for (const batch of tailBatches) {
      for (const msg of batch.messages) {
        total += this.contextSize.sizeOf(msg);
      }
    }
    return total;
  }

  async compact(
    throughIndex?: number,
    options?: CompactionOptions,
  ): Promise<CompactionSlice | undefined> {
    if (this.lifetime.signal.aborted) return undefined;
    options?.signal?.throwIfAborted();
    if (this.pendingCompaction !== undefined) {
      if (
        options === undefined ||
        (options.reason === "threshold" &&
          !options.signal &&
          options.customInstructions === undefined &&
          throughIndex === undefined)
      ) {
        return this.pendingCompaction;
      }
      await this.pendingCompaction.catch(() => {});
      return this.compact(throughIndex, options);
    }
    const task = this.runCompact(throughIndex, options)
      .then((slice) => (this.lifetime.signal.aborted ? undefined : slice))
      .catch((error: unknown) => {
        if (
          this.lifetime.signal.aborted ||
          (options?.reason !== "manual" && error instanceof IncompleteCompactionSummaryError)
        ) {
          return undefined;
        }
        throw error;
      })
      .finally(() => {
        if (this.pendingCompaction === task) {
          this.pendingCompaction = undefined;
        }
      });
    this.pendingCompaction = task;
    return task;
  }

  protected async runCompact(
    throughIndex?: number,
    options?: CompactionOptions,
  ): Promise<CompactionSlice | undefined> {
    const lifetime = this.lifetime.signal;
    options?.signal?.throwIfAborted();
    const resolvedThroughIndex =
      throughIndex ?? (await this.findCutPoint(this.context.batchCount - 1, this.keepRecentTokens));
    if (lifetime.aborted) return undefined;
    if (resolvedThroughIndex < 0) {
      return (await this.readActiveWindow(this.context.batchCount - 1)).slice;
    }
    const { slice, tailBatches } = await this.readActiveWindow(resolvedThroughIndex);
    if (tailBatches.length === 0) {
      return slice;
    }

    if (lifetime.aborted) return undefined;
    const systemMessages = [...(slice?.systemMessages ?? [])];
    const inputMessages: Message[] = [...(slice?.messages ?? [])];
    for (const batch of tailBatches) {
      for (const msg of batch.messages) {
        if (msg instanceof SystemMessage) {
          systemMessages.push(msg);
        } else if (!(msg instanceof RunStopMessage)) {
          inputMessages.push(msg);
        }
      }
    }

    return this.hooks.run.run(
      { ...options, messages: inputMessages, throughIndex: resolvedThroughIndex },
      async (input) => {
        if (lifetime.aborted) return undefined;
        const messages = await this.summarize(input);
        if (lifetime.aborted) return undefined;
        input.signal?.throwIfAborted();
        const nextSlice: CompactionSlice = {
          from: 0,
          to: resolvedThroughIndex,
          systemMessages: snapshotSystemPrompt(systemMessages),
          messages,
        };
        tailBatches[tailBatches.length - 1]!.meta.set(CompactionSliceField, nextSlice);
        return nextSlice;
      },
    );
  }

  protected summarize(input: CompactionInput): Promise<readonly Message[]> {
    return this.hooks.compact.run(input, async (input) => {
      for (const msg of input.messages) {
        if (
          !(msg instanceof UserMessage) &&
          !(msg instanceof AssistantMessage) &&
          !(msg instanceof ToolResultMessage) &&
          !(msg instanceof DeveloperMessage)
        ) {
          throw new Error(
            `Unsupported message type in compaction: ${msg.constructor.name || "Unknown"}`,
          );
        }
      }
      const summary = await this.defaultSummarize(input.messages, input);
      return [summary];
    });
  }

  protected async findCutPoint(
    upToIndex: number = this.context.batchCount - 1,
    keepRecentTokens: number = this.keepRecentTokens,
  ): Promise<number> {
    const slice = await this.latestSlice(upToIndex);
    const minIndex = slice !== undefined ? slice.to + 1 : 0;
    if (upToIndex <= minIndex) {
      return minIndex - 1;
    }
    let accumulated = 0;
    let cutBatchIndex = upToIndex;
    for await (const batch of this.context.readBackward()) {
      if (batch.index > upToIndex) {
        continue;
      }
      if (batch.index < minIndex) {
        break;
      }
      const isValidBoundary =
        batch.messages.length > 0 && !(batch.messages[0] instanceof ToolResultMessage);
      for (const msg of batch.messages) {
        accumulated += this.contextSize.sizeOf(msg);
      }
      if (!isValidBoundary) continue;
      cutBatchIndex = batch.index;
      if (accumulated >= keepRecentTokens) break;
    }
    return cutBatchIndex - 1;
  }

  protected async readActiveWindow(upToIndex: number): Promise<ActiveWindow> {
    const tailBatches: ContextBatch[] = [];
    let slice: CompactionSlice | undefined;

    for await (const batch of this.context.readBackward()) {
      if (batch.index > upToIndex) {
        continue;
      }
      const found = batch.meta.get(CompactionSliceField);
      // Older persisted slices lost their message variants. Reuse the original batches instead.
      if (
        found !== undefined &&
        found.systemMessages.every((message) => message instanceof Message) &&
        found.messages.every((message) => message instanceof Message)
      ) {
        slice = found;
        break;
      }
      tailBatches.push(batch);
    }

    tailBatches.reverse();
    return { slice, tailBatches };
  }

  formatCompactionSummary(summary: string): string {
    return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
  }

  formatBranchSummary(summary: string): string {
    return `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}\n</summary>`;
  }
}

export function useCompaction(options: UseCompactionOptions = {}): void {
  const compaction = inject(PiCompactionService);
  const context = inject(Context);
  const loop = inject(AgentLoop);
  if (options.keepRecentTokens !== undefined) {
    compaction.keepRecentTokens = options.keepRecentTokens;
  }

  loop.hooks.transformContext.use(async (input, next) => {
    const maxTokens = compaction.maxActiveTokens ?? options.maxTokens;
    const backgroundTokens = compaction.backgroundTokens ?? options.backgroundTokens ?? 32768;
    const lastIndex = context.batchCount - 1;
    if (compaction.autoEnabled && maxTokens !== undefined && lastIndex > 0) {
      const activeSize = await compaction.estimateActiveSize(lastIndex);
      if (activeSize > maxTokens) {
        await compaction.compact(undefined, { reason: "threshold" });
      } else if (backgroundTokens > 0 && activeSize > maxTokens - backgroundTokens) {
        void compaction.compact(undefined, { reason: "threshold" }).catch(() => {});
      }
    }
    const slice = await compaction.latestSlice();
    if (slice === undefined) {
      return next(input);
    }
    const stopBeforeIndex = Math.max(input.stopBeforeIndex ?? 0, slice.to + 1);
    const payload = await next({ ...input, stopBeforeIndex });
    return {
      ...payload,
      messages: [
        ...slice.systemMessages,
        ...slice.messages,
        ...sanitizeTailMessages(payload.messages),
      ],
    };
  });

  loop.hooks.handleError.use(async (error, next) => {
    const errorMsg =
      error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const isOverflow = (options.isContextOverflowError ?? defaultIsContextOverflowError)(errorMsg);
    if (!compaction.autoEnabled || !isOverflow) {
      return next();
    }
    const targetIndex = context.batchCount - 1;
    const slice = await compaction.latestSlice();
    const startIndex = slice !== undefined ? slice.to + 1 : 0;
    if (targetIndex < startIndex) {
      return next();
    }
    const compacted = await compaction
      .compact(targetIndex, { reason: "overflow" })
      .catch(() => undefined);
    if (compacted === undefined || compacted.to < targetIndex) {
      return next();
    }
  });
}
