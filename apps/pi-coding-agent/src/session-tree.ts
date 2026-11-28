import {
  buildSessionProjection,
  collectEntriesForBranchSummary,
  convertToLlm,
  prepareBranchEntries,
  serializeConversation,
  type AgentSession,
  type BranchSummaryEntry,
  type ExtensionRunner,
  type FileOperations,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SupplementaryField } from "@harness/agent-loop";
import { Context } from "@harness/context";
import { createDescriptor, type Scope } from "@harness/di";
import {
  extractText,
  Message,
  TextBlock,
  UserMessage,
  type LlmModelInfo,
  type LlmService,
} from "@harness/llm";
import { CompactionSliceField, CompactionSummaryMessage } from "@harness/pi-compaction";
import { SqliteService } from "@harness/sqlite";
import { fromPiContent, piUsage } from "./extension-content.ts";
import type { RetrySummary } from "./pi-events.ts";
import { projectPiContext } from "./session-import.ts";
import { readSessionHistory, type SessionCatalog } from "./session-catalog.ts";
import { readPiToolHistory, readToolHistory } from "./tool-selection.ts";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { computeFileLists, formatFileOperations } = (await import(
  new URL("core/compaction/utils.js", sdk).href
)) as {
  computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] };
  formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
};
const branchSummaryPreamble =
  "The user explored a different conversation branch before returning here.\n" +
  "Summary of that exploration:\n\n";

export interface SessionTreeState {
  readonly branchId: string;
  readonly leafId: string | null;
  readonly entries: readonly SessionEntry[];
  readonly nativeToPi: readonly (readonly [nativeId: string, entryId: string])[];
  readonly checkpoints: readonly (readonly [leafId: string | null, branchId: string])[];
  readonly importedEntryIds: readonly string[];
}

async function forkAtMessage(root: Scope, context: Context, nativeIds: ReadonlySet<string>) {
  const matches = (message: Message) => nativeIds.has(message.id);
  const pendingIndex = context.pending.findLastIndex(matches);
  if (pendingIndex >= 0) {
    const forked = await context.fork();
    const scope = root.createChild();
    try {
      scope.provide(createDescriptor(Context, forked));
      scope.get(Context).pending.splice(pendingIndex + 1);
      return forked;
    } finally {
      scope.dispose();
    }
  }
  for await (const batch of context.readBackward()) {
    const index = batch.messages.findLastIndex(matches);
    if (index >= 0)
      return context.fork({ at: { batchIndex: batch.index, messageCount: index + 1 } });
  }
  return undefined;
}

interface SessionTreeOptions {
  readonly root: Scope;
  readonly catalog: SessionCatalog;
  readonly sessionId: string;
  readonly getContext: () => Context;
  readonly switchContext: (branchId: string) => void;
  readonly llm: LlmService;
  readonly transcript: SessionManager;
  readonly entryIds: Map<string, string>;
  readonly nativeIds: Map<string, string>;
  readonly saved?: SessionTreeState;
  readonly importedEntries: readonly SessionEntry[];
  readonly getRunner: () => ExtensionRunner;
  readonly getModel: () => LlmModelInfo;
  readonly getReserveTokens: () => number;
  readonly retrySummary: RetrySummary;
  readonly isBusy: () => boolean;
  readonly restoreTools: () => Promise<void>;
}

export function createSessionTree(options: SessionTreeOptions) {
  const { root, catalog, sessionId, getContext, transcript, entryIds, nativeIds } = options;
  const checkpoints = new Map(options.saved?.checkpoints);
  const imported = new Set(
    options.saved?.importedEntryIds ?? options.importedEntries.map((entry) => entry.id),
  );
  let saved = options.saved !== undefined;
  let running:
    | { readonly controller: AbortController; readonly done: PromiseWithResolvers<void> }
    | undefined;

  function track(nativeId: string, entryId: string): void {
    entryIds.set(nativeId, entryId);
    nativeIds.set(entryId, nativeId);
  }

  function save(branchId = getContext().id): Promise<void> {
    if (!saved) return Promise.resolve();
    return catalog.saveTree(sessionId, {
      branchId,
      leafId: transcript.getLeafId(),
      entries: transcript.getEntries(),
      nativeToPi: [...entryIds],
      checkpoints: [...checkpoints],
      importedEntryIds: [...imported],
    });
  }

  function persist(): Promise<void> {
    saved = true;
    return running ? Promise.resolve() : save();
  }

  const appendLabel = transcript.appendLabelChange.bind(transcript);
  transcript.appendLabelChange = (entryId, label) => {
    const id = appendLabel(entryId, label);
    void persist().catch((error: unknown) => console.error(error));
    return id;
  };

  function setLeaf(leafId: string | null): void {
    if (leafId === null) transcript.resetLeaf();
    else transcript.branch(leafId);
  }

  async function chooseBranch(
    leafId: string | null,
    trackProjectedEntries: boolean,
  ): Promise<string> {
    const context = getContext();
    const entries = transcript.getEntries();
    const projection = buildSessionProjection(entries, leafId);
    const entry = projection.entries.findLast(
      ({ sourceEntry, messages }) =>
        sourceEntry.type === "custom" ||
        sourceEntry.type === "context_edit" ||
        sourceEntry.type === "usage" ||
        messages.length > 0,
    )?.sourceEntry;
    const first = projection.entries[0]?.sourceEntry;
    const expectedSummary = first?.type === "compaction" ? first.id : undefined;
    const hasCompaction = entries.some(({ type }) => type === "compaction");
    const branch = leafId === null ? [] : transcript.getBranch(leafId);
    const expectedTools = readPiToolHistory(branch)?.active;
    const anchor = branch.findLast(({ id }) => id === entry?.id || id === expectedSummary);

    async function forkVisibleHistory(source: Context, matches: ReadonlySet<string>) {
      const forked = await forkAtMessage(root, source, matches);
      if (!forked?.id || (!hasCompaction && expectedTools === undefined)) return forked?.id;
      const scope = root.createChild();
      try {
        scope.provide(createDescriptor(Context, forked));
        const fork = scope.get(Context);
        if (expectedTools !== undefined) {
          // Pi's pre-prompt tool patch can fall on the other side of a native history cut.
          const actual = readToolHistory(await readSessionHistory(fork), [])?.active ?? [];
          if (
            expectedTools.length !== actual.length ||
            expectedTools.some((name, i) => name !== actual[i])
          ) {
            return undefined;
          }
        }
        // A retained batch can carry a summary written after the selected Pi entry.
        if (!hasCompaction) return forked.id;
        for await (const batch of fork.readBackward()) {
          const slice = batch.meta.get(CompactionSliceField);
          if (slice === undefined) continue;
          const summary = slice.messages.find(
            (message) => message instanceof CompactionSummaryMessage,
          );
          return summary &&
            expectedSummary === entryIds.get(summary.id) &&
            expectedSummary !== undefined
            ? forked.id
            : undefined;
        }
        return expectedSummary === undefined ? forked.id : undefined;
      } finally {
        scope.dispose();
      }
    }

    if (entry && leafId && !imported.has(leafId)) {
      const matches = new Set(
        [...entryIds]
          .filter(([, entryId]) => entryId === entry.id || entryId === anchor?.id)
          .map(([nativeId]) => nativeId),
      );
      if (matches.size > 0) {
        const current = await forkVisibleHistory(context, matches);
        if (current) return current;
        for (const [checkpointLeaf, branchId] of checkpoints) {
          if (
            branchId === context.id ||
            !checkpointLeaf ||
            !transcript.getBranch(checkpointLeaf).some(({ id }) => id === entry.id)
          )
            continue;
          const scope = root.createChild();
          try {
            scope.provide(createDescriptor(Context, { id: branchId }));
            const forked = await forkVisibleHistory(scope.get(Context), matches);
            if (forked) return forked;
          } finally {
            scope.dispose();
          }
        }
      }
    }
    const { messages, nativeToPi } = projectPiContext(projection);
    const branchId = crypto.randomUUID();
    const scope = root.createChild();
    try {
      scope.provide(createDescriptor(Context, { id: branchId, initialPending: messages }));
      if (messages.length > 0) scope.get(Context).batch();
      if (trackProjectedEntries) {
        for (const [nativeId, entryId] of nativeToPi) track(nativeId, entryId);
      }
    } finally {
      scope.dispose();
    }
    return branchId;
  }

  async function summarize(
    entries: SessionEntry[],
    signal: AbortSignal,
    instructions?: string,
    replace?: boolean,
  ) {
    const model = options.getModel();
    const prepared = prepareBranchEntries(
      entries,
      Math.max(0, model.contextWindow - options.getReserveTokens()),
    );
    if (prepared.messages.length === 0) return undefined;
    const prompt =
      "Summarize the branch being left. Preserve decisions, changes, relevant files, and open work for the agent continuing on another branch.";
    const request =
      replace && instructions ? instructions : [prompt, instructions].filter(Boolean).join("\n\n");
    const payload = {
      provider: model.provider,
      model: model.id,
      signal,
      systemPrompt: request,
      messages: [
        UserMessage.create({
          content: [
            TextBlock.create({ text: serializeConversation(convertToLlm(prepared.messages)) }),
          ],
        }),
      ],
    };
    const result = await options.retrySummary(
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      signal,
      async () => {
        const stream = options.llm.stream(payload);
        for await (const _chunk of stream) {
        }
        const result = await stream.result();
        signal.throwIfAborted();
        if (result.stopReason !== "stop") {
          throw new Error(
            result.error?.message ?? `Branch summary stopped with ${result.stopReason}`,
          );
        }
        return result;
      },
    );
    const details = computeFileLists(prepared.fileOps);
    const summary = result.message.content
      .filter((block) => block instanceof TextBlock)
      .map((block) => block.text)
      .join("\n");
    return {
      summary:
        branchSummaryPreamble +
        summary +
        formatFileOperations(details.readFiles, details.modifiedFiles),
      usage: result.usage ? piUsage(result.usage) : undefined,
      details,
    };
  }

  const navigate: AgentSession["navigateTree"] = async (targetId, request = {}) => {
    if (running || options.isBusy())
      throw new Error(
        "Wait for the current operation to finish before navigating the session tree.",
      );
    const oldLeafId = transcript.getLeafId();
    if (targetId === oldLeafId) return { cancelled: false };
    const target = transcript.getEntry(targetId);
    if (!target) throw new Error(`Entry ${targetId} not found`);
    const { entries, commonAncestorId } = collectEntriesForBranchSummary(
      transcript,
      oldLeafId,
      targetId,
    );
    const edited =
      target.type === "message" && target.message.role === "user"
        ? target.message.content
        : target.type === "custom_message"
          ? target.content
          : undefined;
    const leafId = edited === undefined ? target.id : target.parentId;
    const editorText = edited === undefined ? undefined : extractText(fromPiContent(edited));
    const operation = { controller: new AbortController(), done: Promise.withResolvers<void>() };
    const { signal } = operation.controller;
    const previousBranchId = getContext().id;
    let changedLeaf = false;
    running = operation;
    try {
      const negotiated = await options.getRunner().emit({
        type: "session_before_tree",
        preparation: {
          targetId,
          oldLeafId,
          commonAncestorId,
          entriesToSummarize: entries,
          userWantsSummary: request.summarize ?? false,
          customInstructions: request.customInstructions,
          replaceInstructions: request.replaceInstructions,
          label: request.label,
        },
        signal,
      });
      if (negotiated?.cancel) return { cancelled: true };
      signal.throwIfAborted();
      const supplied = request.summarize ? negotiated?.summary : undefined;
      const summary =
        supplied ??
        (request.summarize && entries.length > 0
          ? await summarize(
              entries,
              signal,
              negotiated?.customInstructions ?? request.customInstructions,
              negotiated?.replaceInstructions ?? request.replaceInstructions,
            )
          : undefined);
      const branchId = await chooseBranch(leafId, true);
      signal.throwIfAborted();
      checkpoints.set(oldLeafId, previousBranchId);
      const label = negotiated?.label ?? request.label;
      let summaryEntry: BranchSummaryEntry | undefined;
      changedLeaf = true;
      if (summary?.summary) {
        const id = transcript.branchWithSummary(
          leafId,
          summary.summary,
          summary.details,
          !!supplied,
          summary.usage,
        );
        const entry = transcript.getEntry(id);
        if (entry?.type !== "branch_summary") throw new Error("Branch summary was not projected");
        summaryEntry = entry;
        const { messages } = projectPiContext(
          buildSessionProjection([{ ...entry, parentId: null }]),
        );
        const scope = root.createChild();
        try {
          scope.provide(createDescriptor(Context, { id: branchId }));
          const pending = scope.get(Context).pending;
          for (const message of messages) {
            message.meta.set(SupplementaryField, true);
            pending.push(message);
            track(message.id, id);
          }
        } finally {
          scope.dispose();
        }
        if (label) transcript.appendLabelChange(id, label);
      } else {
        setLeaf(leafId);
        if (label) transcript.appendLabelChange(targetId, label);
      }
      await root.get(SqliteService).flush();
      saved = true;
      await save(branchId);
      options.switchContext(branchId);
      await options.restoreTools();
      running = undefined;
      await options.getRunner().emit({
        type: "session_tree",
        newLeafId: transcript.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryEntry ? !!supplied : undefined,
      });
      return { cancelled: false, editorText, summaryEntry };
    } catch (error) {
      if (changedLeaf && getContext().id === previousBranchId) setLeaf(oldLeafId);
      if (signal.aborted) return { cancelled: true, aborted: true };
      throw error;
    } finally {
      if (running === operation) running = undefined;
      operation.done.resolve();
    }
  };
  return {
    get isNavigating() {
      return running !== undefined;
    },
    navigate,
    forkAt: (leafId: string | null) => chooseBranch(leafId, false),
    persist,
    save,
    abort() {
      running?.controller.abort();
    },
    waitForIdle: () => running?.done.promise ?? Promise.resolve(),
  };
}
