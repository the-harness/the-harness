import {
  prepareBranchEntries,
  type CompactionEntryDraft,
  type CompactionResult,
  type ExtensionRunner,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Context } from "@harness/context";
import type { ContextSizeService } from "@harness/context-size";
import {
  snapshotSystemPrompt,
  SystemMessage,
  TextBlock,
  type LlmModelInfo,
  type Message,
} from "@harness/llm";
import {
  CompactionSummaryMessage,
  CompactionSliceField,
  type CompactionInput,
  type CompactionSlice,
  type PiCompactionService,
} from "@harness/pi-compaction";
import { AddToolMessage, RemoveToolMessage } from "@harness/tool-call";
import {
  CompactionCheckpoint,
  CompactionProjectionField,
  includeInModelContext,
  piUsage,
  projectModelMessages,
  stampMessage,
  toPiMessages,
  type CompactionProjection,
} from "./extension-content.ts";
import { appendBoundaryCompaction, estimateSessionTokens } from "./extension-context.ts";
import type { PiEvents, RetrySummary } from "./pi-events.ts";
import { readSessionHistory } from "./session-catalog.ts";

interface SessionCompactionOptions {
  readonly context: Context;
  readonly contextSize: ContextSizeService;
  readonly compaction: PiCompactionService;
  readonly transcript: SessionManager;
  readonly events: PiEvents;
  readonly entryIds: Map<string, string>;
  readonly model: () => LlmModelInfo;
  readonly settings: () => SettingsManager;
  readonly runner: () => ExtensionRunner;
  readonly retrySummary: RetrySummary;
  readonly stopAgent: () => Promise<void>;
  readonly agentSignal: () => AbortSignal | undefined;
}

type CompactionReason = NonNullable<CompactionInput["reason"]>;

interface CompactionOperation {
  readonly reason: CompactionReason;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly done: PromiseWithResolvers<void>;
  fromExtension: boolean;
  /** Whether `run` already emitted this operation's `compaction_end`. */
  reported: boolean;
  result?: CompactionResult;
}

export function createSessionCompaction(options: SessionCompactionOptions) {
  const { contextSize, transcript, events, entryIds } = options;
  let active: CompactionOperation | undefined;

  function startOperation(reason: CompactionReason): CompactionOperation {
    const controller = new AbortController();
    const parentSignal = reason === "manual" ? undefined : options.agentSignal();
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    const operation = {
      reason,
      controller,
      signal,
      done: Promise.withResolvers<void>(),
      fromExtension: false,
      reported: false,
    };
    active = operation;
    return operation;
  }

  async function firstKeptId(throughIndex: number): Promise<string | undefined> {
    const { context } = options;
    const find = (messages: readonly Message[]) =>
      messages.find((message) => entryIds.has(message.id))?.id;
    let first = find(context.pending);
    for await (const batch of context.readBackward()) {
      if (batch.index <= throughIndex) break;
      first = find(batch.messages) ?? first;
    }
    return first;
  }

  function append(summary: CompactionSummaryMessage, projection: CompactionProjection) {
    const previousId = entryIds.get(summary.id);
    const previous = previousId ? transcript.getEntry(previousId) : undefined;
    if (previous?.type === "compaction") return previous;
    const usage = projection.usage ?? (summary.usage ? piUsage(summary.usage) : undefined);
    const firstKeptEntryId = projection.firstKeptMessageId
      ? entryIds.get(projection.firstKeptMessageId)
      : undefined;
    const id = transcript.appendCompaction(
      summary.summary!,
      firstKeptEntryId ?? null,
      projection.tokensBefore,
      projection.details,
      projection.fromExtension,
      usage,
    );
    const entry = transcript.getEntry(id);
    if (entry?.type !== "compaction") throw new Error("Compaction entry was not projected");
    entryIds.set(summary.id, id);
    return entry;
  }

  async function commitBoundary(draft: CompactionEntryDraft) {
    const { context, compaction } = options;
    const history = await readSessionHistory(context);
    const entry = appendBoundaryCompaction(transcript, draft);
    const keptIds = new Set(
      transcript
        .buildSessionProjection()
        .entries.flatMap(({ sourceEntry }) =>
          sourceEntry.type === "compaction" ? [] : [sourceEntry.id],
        ),
    );
    const systemMessages: SystemMessage[] = [];
    const tools = new Map<string, AddToolMessage>();
    const retained: Message[] = [];
    for (const message of history) {
      if (message instanceof SystemMessage) systemMessages.push(message);
      else if (message instanceof AddToolMessage) tools.set(message.tool.name, message);
      else if (message instanceof RemoveToolMessage) tools.delete(message.toolName);
      else if (keptIds.has(entryIds.get(message.id) ?? "")) retained.push(message);
    }

    const summary = CompactionSummaryMessage.create({
      from: 0,
      to: context.batchCount,
      summary: entry.summary,
      content: [TextBlock.create({ text: compaction.formatCompactionSummary(entry.summary) })],
    });
    stampMessage(summary, Date.parse(entry.timestamp));
    summary.meta.set(CompactionProjectionField, {
      afterMessageId: summary.id,
      firstKeptMessageId: retained[0]?.id,
      tokensBefore: entry.tokensBefore,
      fromExtension: true,
      details: entry.details,
      usage: entry.usage,
    });
    const slice: CompactionSlice = {
      from: 0,
      to: context.batchCount,
      systemMessages: snapshotSystemPrompt(systemMessages),
      messages: [summary, ...tools.values(), ...retained],
    };
    context.pending.push(CompactionCheckpoint.create({ id: summary.id }));
    context.batch().meta.set(CompactionSliceField, slice);
    entryIds.set(summary.id, entry.id);
    return entry;
  }

  async function prepare(
    input: CompactionInput,
    next: (input: CompactionInput) => Promise<readonly Message[]>,
  ): Promise<readonly Message[]> {
    const history = transcript.getBranch().some(({ type }) => type === "context_edit")
      ? await readSessionHistory(options.context, input.signal)
      : input.messages;
    const request = { ...input, messages: projectModelMessages(input.messages, history) };
    const operation = active;
    if (!operation || input.signal !== operation.signal) return next(request);

    const firstKeptMessageId = await firstKeptId(input.throughIndex);
    const firstKeptEntryId = firstKeptMessageId ? (entryIds.get(firstKeptMessageId) ?? "") : "";
    const branchEntries = transcript.getBranch();
    const boundary = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    const prefix = boundary < 0 ? branchEntries : branchEntries.slice(0, boundary);
    const tokensBefore = estimateSessionTokens(transcript);
    const previous = request.messages.find(
      (message) => message instanceof CompactionSummaryMessage,
    );
    const model = options.model();
    const settings = options
      .settings()
      .getCompactionSettings({ provider: model.provider, id: model.id });
    const result = await options.runner().emit({
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId,
        messagesToSummarize: toPiMessages(
          request.messages.filter((message) => message !== previous),
        ),
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore,
        previousSummary: previous?.summary,
        fileOps: prepareBranchEntries(prefix).fileOps,
        settings,
      },
      branchEntries,
      customInstructions: input.customInstructions,
      reason: operation.reason,
      willRetry: operation.reason === "overflow",
      signal: operation.signal,
    });
    if (result?.cancel) operation.controller.abort(new Error("Compaction cancelled"));
    operation.signal.throwIfAborted();

    const custom = result?.compaction;
    operation.fromExtension = custom !== undefined;
    if (custom && custom.firstKeptEntryId !== firstKeptEntryId) {
      throw new Error("Extension compaction must keep the batch boundary in its preparation");
    }
    const messages = custom
      ? [
          CompactionSummaryMessage.create({
            from: 0,
            to: input.throughIndex,
            summary: custom.summary,
            content: [
              TextBlock.create({
                text: options.compaction.formatCompactionSummary(custom.summary),
              }),
            ],
          }),
        ]
      : await options.retrySummary(
          {
            type: "summarization_retry_attempt_start",
            source: "compaction",
            reason: operation.reason,
          },
          operation.signal,
          () => next(request),
        );
    const summary = messages.find((message) => message instanceof CompactionSummaryMessage);
    if (!summary?.summary) throw new Error("No compaction summary was produced");
    stampMessage(summary);
    summary.meta.set(CompactionProjectionField, {
      afterMessageId: [...entryIds.keys()].at(-1),
      firstKeptMessageId,
      tokensBefore: custom?.tokensBefore ?? tokensBefore,
      fromExtension: operation.fromExtension,
      details: custom?.details,
      usage: custom?.usage,
    });
    return messages;
  }

  async function estimateActiveSize(): Promise<number> {
    const { context, compaction } = options;
    return (
      (await compaction.estimateActiveSize()) +
      context.pending
        .filter(includeInModelContext)
        .reduce((total, message) => total + contextSize.sizeOf(message), 0)
    );
  }

  async function run(
    input: CompactionInput,
    next: (input?: CompactionInput) => Promise<CompactionSlice | undefined>,
  ): Promise<CompactionSlice | undefined> {
    if (input.reason === undefined) return next();
    const manual = input.reason === "manual";
    if (active && (!manual || input.signal !== active.signal)) return undefined;
    const operation = active ?? startOperation(input.reason);
    const { reason, signal } = operation;
    const willRetry = reason === "overflow";
    try {
      events.emit({ type: "compaction_start", reason });
      signal.throwIfAborted();
      const slice = await next({ ...input, signal });
      const summary = slice?.messages.find(
        (message) => message instanceof CompactionSummaryMessage,
      );
      const projection = summary?.meta.get(CompactionProjectionField);
      if (!summary || !projection) throw new Error("No compaction summary was produced");
      const entry = append(summary, projection);
      const result: CompactionResult = {
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId ?? "",
        tokensBefore: entry.tokensBefore,
        estimatedTokensAfter: await estimateActiveSize(),
        usage: entry.usage,
        details: entry.details,
      };
      await options.runner().emit({
        type: "session_compact",
        compactionEntry: entry,
        fromExtension: operation.fromExtension,
        reason,
        willRetry,
      });
      operation.result = result;
      active = undefined;
      operation.reported = true;
      events.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
      return slice;
    } catch (error) {
      active = undefined;
      const aborted = signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      const label =
        reason === "overflow"
          ? "Context overflow recovery"
          : manual
            ? "Compaction"
            : "Auto-compaction";
      const errorMessage = aborted ? undefined : `${label} failed: ${message}`;
      operation.reported = true;
      events.emit({
        type: "compaction_end",
        reason,
        result: undefined,
        errorMessage,
        aborted,
        willRetry: false,
      });
      await options.runner().emit({
        type: "session_compact_failed",
        reason,
        errorMessage,
        aborted,
        willRetry: false,
        fromExtension: operation.fromExtension,
      });
      if (manual) throw error;
      return undefined;
    } finally {
      operation.done.resolve();
    }
  }

  async function compact(customInstructions?: string): Promise<CompactionResult> {
    if (active) throw new Error("Compaction is already running");
    const operation = startOperation("manual");
    try {
      await options.stopAgent();
      const model = options.model();
      const { compaction } = options;
      compaction.keepRecentTokens = options
        .settings()
        .getCompactionKeepRecentTokens({ provider: model.provider, id: model.id });
      const slice = await compaction.compact(undefined, {
        signal: operation.signal,
        customInstructions,
        reason: operation.reason,
      });
      if (!operation.result)
        throw new Error(slice ? "Already compacted" : "Nothing to compact (session too small)");
      return operation.result;
    } catch (error) {
      if (!operation.reported) {
        // The compaction service returned before running the hook, so report the failure here.
        const aborted = operation.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
        operation.reported = true;
        events.emit({
          type: "compaction_end",
          reason: operation.reason,
          result: undefined,
          errorMessage,
          aborted,
          willRetry: false,
        });
        await options.runner().emit({
          type: "session_compact_failed",
          reason: operation.reason,
          errorMessage,
          aborted,
          willRetry: false,
          fromExtension: operation.fromExtension,
        });
      }
      throw error;
    } finally {
      if (active === operation) active = undefined;
      operation.done.resolve();
    }
  }

  async function storedSummaries() {
    const stored: Array<{ summary: CompactionSummaryMessage; projection: CompactionProjection }> =
      [];
    for await (const batch of options.context.readBackward()) {
      const summary = batch.meta
        .get(CompactionSliceField)
        ?.messages.find((message) => message instanceof CompactionSummaryMessage);
      const projection = summary?.meta.get(CompactionProjectionField);
      if (summary?.summary !== undefined && projection) stored.push({ summary, projection });
    }
    return stored.reverse();
  }

  return {
    append,
    commitBoundary,
    prepare,
    run,
    compact,
    storedSummaries,
    get isCompacting() {
      return active !== undefined;
    },
    abort() {
      active?.controller.abort(new Error("Compaction cancelled"));
    },
    waitForIdle: () => active?.done.promise ?? Promise.resolve(),
  };
}
