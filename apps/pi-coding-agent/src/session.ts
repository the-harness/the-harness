import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getCurrentTools,
  getToolStateChanges,
  isContextOverflow,
  isRetryableAssistantError,
  retryDelayMs,
} from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  convertToLlm,
  readStoredCredential,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  VIRTUAL_MODEL_STATE_ENTRY,
  type AgentSession,
  type AgentSessionRuntimeDiagnostic,
  type CacheWarmingMode,
  type ExtensionActions,
  type ModelRoute,
  type ProjectTrustContext,
  type PromptOptions,
  type ScopedModel,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentLoop, SupplementaryField, type LlmInputPayload } from "@harness/agent-loop";
import { Context } from "@harness/context";
import { ContextSizeService } from "@harness/context-size";
import { CwdService } from "@harness/cwd";
import { useDeepSeekProvider } from "@harness/deepseek";
import { createDescriptor, createRootScope, type Scope } from "@harness/di";
import { LinkedTree } from "@harness/linked-tree";
import {
  AssistantMessage,
  extractText,
  ImageBlock,
  LlmService,
  MessageMeta,
  SystemMessage,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  FunctionToolDeclaration,
  type ContentBlock,
  type LlmModelInfo,
  type LlmRequest,
  type LlmStreamChunk,
  type Message,
  type ToolDeclaration,
} from "@harness/llm";
import { fromPiTool, toPiTool } from "./tool-declarations.ts";
import { McpService } from "@harness/mcp";
import { ProviderManager } from "@harness/model-provider";
import { ModelSelectionService, type ModelSelection } from "@harness/model-selection";
import { createPiPromptSection, PiCodingAgentPreset } from "@harness/pi-coding-agent";
import { PiCompactionService } from "@harness/pi-compaction";
import { createBashExecutor, truncateTail } from "@harness/pi-tools";
import { SqliteService } from "@harness/sqlite";
import { ToolCallService } from "@harness/tool-call";
import {
  BashExecution,
  bashMessage,
  ContextEditMessage,
  contextEditMessage,
  customMessage,
  ExtensionEntry,
  extensionEntry,
  fromPiAssistant,
  fromPiContent,
  parseToolInput,
  projectModelMessages,
  readToolResultData,
  replacePiUserMessage,
  SessionUsage,
  sessionUsage,
  stampImportedMessage,
  stampMessage,
  toPiContent,
  toPiMessages,
  type PiAssistant,
  type PiCustomMessage,
  type PiMessage,
  type PiToolResult,
} from "./extension-content.ts";
import {
  contextUsage,
  dispatchBoundary,
  fromPiMessage,
  projectPiRequestMessages,
  transformExtensionContext,
  type BoundaryEvent,
} from "./extension-context.ts";
import { loadExtensions, prepareExtensionResources, type ExtensionOptions } from "./extensions.ts";
import {
  CacheWarmer,
  DEFAULT_THINKING_LEVEL,
  findLatestResponse,
  getVirtualModelState,
  isVirtualModel,
  PiLlmService,
  PiModelProviders,
  PiRuntimeApiKey,
} from "./model-providers.ts";
import { formatNoModelsAvailableMessage, modelResolverCatalog } from "./model-selection.ts";
import {
  PiEvents,
  type PersistedTurn,
  type RetrySummary,
  type TurnInputMessage,
} from "./pi-events.ts";
import { processImage } from "./pi-input.ts";
import type { ProjectTrustResolver } from "./project-trust.ts";
import {
  initializeSessionCatalog,
  readSessionHistory,
  type SessionCatalog,
} from "./session-catalog.ts";
import { createSessionCompaction } from "./session-compaction.ts";
import { forkStartupSession } from "./session-fork.ts";
import { ImportedTranscriptField, type ImportedSession } from "./session-import.ts";
import { createSessionTree } from "./session-tree.ts";
import { readToolHistory, toolSystemMessages } from "./tool-selection.ts";

export interface SessionOptions {
  readonly cwd: string;
  readonly storedCwd?: string;
  readonly database: string;
  readonly sessionId?: string;
  readonly sessionReference?: string;
  readonly forkReference?: string;
  readonly pickSession?: boolean;
  readonly name?: string;
  readonly parentSession?: string;
  readonly continueRecent?: boolean;
  readonly startReason?: SessionStartEvent["reason"];
  readonly provider?: string;
  readonly model?: string;
  readonly modelPatterns?: readonly string[];
  readonly thinking?: string;
  /** Selection a replacement session keeps while the model is still offered; otherwise the default resolution applies. */
  readonly retainSelection?: { readonly provider: string; readonly model: string; readonly thinking: string };
  readonly apiKey?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly imported?: ImportedSession;
  readonly extensions: ExtensionOptions;
}

type Queue = "steer" | "followUp";
type QueueMode = "all" | "one-at-a-time";
type ThinkingLevel = AgentSession["thinkingLevel"];
type ModelMutationOptions = Parameters<AgentSession["setModel"]>[1];
const thinkingLevels: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
type BashResult = Awaited<ReturnType<AgentSession["executeBash"]>>;
type BashOptions = Parameters<AgentSession["executeBash"]>[2];
interface QueuedInput {
  readonly message: UserMessage;
  readonly text?: string;
}
type TurnInput =
  | {
      readonly kind: "user";
      readonly text: string;
      readonly attachments: readonly ContentBlock[];
      readonly source?: "extension";
      readonly expandPromptTemplates?: boolean;
    }
  | { readonly kind: "custom"; readonly message: PiCustomMessage };

interface PreparedTurnInput {
  readonly original: TurnInputMessage;
  readonly edited: TurnInputMessage;
  readonly messages: readonly Message[];
}

function replaceImages(
  content: readonly ContentBlock[],
  images: NonNullable<PromptOptions["images"]>,
): ContentBlock[] {
  return [...content.filter((part) => !(part instanceof ImageBlock)), ...fromPiContent(images)];
}

function selectModel(
  models: readonly LlmModelInfo[],
  options: Pick<SessionOptions, "provider" | "model">,
): LlmModelInfo {
  const selected = models.find(
    (model) =>
      (options.provider === undefined || model.provider === options.provider) &&
      (options.model === undefined || model.id === options.model),
  );
  if (!selected) throw new Error(`Model not found: ${options.model ?? options.provider}`);
  return selected;
}

export function availableThinkingLevels(model: LlmModelInfo): ThinkingLevel[] {
  const { reasoning } = model;
  if (reasoning === true) return [...thinkingLevels];
  return thinkingLevels.filter(
    (level) => level === "off" || (Array.isArray(reasoning) && reasoning.includes(level)),
  );
}

function resolveThinking(
  model: LlmModelInfo,
  value?: string | boolean,
): string | false | undefined {
  if (model.reasoning === false || value === false || value === "off") return false;
  if (value === undefined) return undefined;
  const index = thinkingLevels.findIndex((level) => level === value);
  if (index < 0) return undefined;
  const level = availableThinkingLevels(model).findLast(
    (candidate) => thinkingLevels.indexOf(candidate) <= index,
  );
  return level === "off" ? false : level;
}

function thinkingLevel(value?: string | boolean): ThinkingLevel {
  return value === false
    ? "off"
    : (thinkingLevels.find((level) => level === value) ?? DEFAULT_THINKING_LEVEL);
}

function deepSeekKey(agentDir: string, runtimeKey: PiRuntimeApiKey): string | undefined {
  if (runtimeKey.provider === "deepseek" && runtimeKey.key !== undefined) return runtimeKey.key;
  const stored = readStoredCredential("deepseek", join(agentDir, "auth.json"));
  return (
    (stored?.type === "api_key" ? stored.key : undefined) ??
    process.env["DEEPSEEK_API_KEY"] ??
    process.env["ANTHROPIC_AUTH_TOKEN"]
  );
}

export class NoModelsAvailableError extends Error {
  constructor() {
    super(formatNoModelsAvailableMessage());
    this.name = "NoModelsAvailableError";
  }
}

export async function createSessionRoot({ database, apiKey, extensions }: SessionOptions) {
  if (database !== ":memory:") mkdirSync(dirname(database), { recursive: true });
  const root = createRootScope({ id: "pi-cli" });
  try {
    root.provideAll([
      createDescriptor(SqliteService, { path: database }),
      LinkedTree,
      ProviderManager,
      LlmService,
      createDescriptor(PiRuntimeApiKey, apiKey),
      McpService,
    ]);
    const runtimeKey = root.get(PiRuntimeApiKey);
    root.run(() => {
      useDeepSeekProvider({
        baseUrl: process.env["DEEPSEEK_BASE_URL"],
        apiKey: () => deepSeekKey(extensions.agentDir, runtimeKey),
      });
    });
    initializeSessionCatalog(root.get(SqliteService), database);
    return root;
  } catch (error) {
    root.dispose();
    throw error;
  }
}

export async function createSession(
  root: Scope,
  catalog: SessionCatalog,
  options: SessionOptions,
  trust: ProjectTrustResolver,
  trustContext?: ProjectTrustContext,
) {
  const scope = root.createChild();
  try {
    const sqlite = root.get(SqliteService);
    const startup = options.startReason === undefined || options.forkReference !== undefined;
    const { settings, resources, flagErrors } = await prepareExtensionResources(
      options.cwd,
      options.extensions,
      trust,
      startup,
      trustContext,
    );
    if (startup && flagErrors.length) throw new Error(flagErrors.join("\n"));
    const requestedId =
      options.forkReference === undefined
        ? options.sessionId
        : await forkStartupSession(
            root,
            catalog,
            options.cwd,
            options.forkReference,
            options.sessionId,
          );
    const saved = requestedId
      ? catalog.get(requestedId)
      : options.continueRecent
        ? catalog.latest(options.cwd)
        : undefined;
    if (saved && saved.deleted_at !== null)
      throw new Error(`Session '${saved.id}' is in the trash`);
    const storedCwd = options.storedCwd ?? options.cwd;
    if (saved && saved.cwd !== storedCwd)
      throw new Error(`Session '${saved.id}' belongs to ${saved.cwd}`);
    const id = requestedId ?? saved?.id ?? crypto.randomUUID();
    const savedTree = catalog.getTree(id);
    const parentSession = options.parentSession ?? saved?.parent_id ?? undefined;
    const createdAt =
      saved?.created_at ?? options.imported?.createdAt ?? saved?.updated_at ?? Date.now();
    scope.provideAll([
      createDescriptor(Context, {
        id: savedTree?.branchId ?? id,
        initialPending: options.imported?.messages,
      }),
      createDescriptor(CwdService, options.cwd),
      ModelSelectionService,
      createDescriptor(PiModelProviders, root.get(LlmService)),
      createDescriptor(PiLlmService, selectRequestModel),
      createDescriptor(AgentLoop, { sessionId: id }),
      ContextSizeService,
      PiCompactionService,
      ToolCallService,
    ]);
    const preset = PiCodingAgentPreset.create({ id: "pi-coding-agent", name: "Pi Coding Agent" });
    let prepareSystemPrompt: ReturnType<PiCodingAgentPreset["setup"]>;
    let context = scope.get(Context);
    const llm = scope.get(LlmService);
    const modelProviders = scope.get(PiModelProviders);
    if (options.imported)
      context.batch().meta.set(ImportedTranscriptField, options.imported.transcript);
    let loop = scope.get(AgentLoop);
    const selection = scope.get(ModelSelectionService);
    const toolCall = scope.get(ToolCallService);
    let compaction = scope.get(PiCompactionService);
    const bash = scope.run(() => createBashExecutor(id));
    const runningBash = new Map<AbortController, Promise<BashResult>>();
    const pendingBash: UserMessage[] = [];
    const batches: (readonly Message[])[] = [];
    let imported = options.imported?.transcript;
    for await (const batch of context.readBackward()) {
      batches.push(batch.messages);
      imported ??= batch.meta.get(ImportedTranscriptField);
    }
    const stored = [...batches.reverse().flat(), ...context.pending];
    const storedEntries =
      saved || imported || savedTree
        ? [
            {
              type: "session" as const,
              version: CURRENT_SESSION_VERSION,
              id,
              cwd: storedCwd,
              timestamp: new Date(createdAt).toISOString(),
              parentSession,
            },
            ...(savedTree?.entries ?? imported?.entries ?? []),
          ]
        : undefined;
    const transcript = SessionManager.inMemory(options.cwd, { id, parentSession }, storedEntries);
    if (savedTree?.leafId === null) transcript.resetLeaf();
    else if (savedTree?.leafId) transcript.branch(savedTree.leafId);
    const name = options.name?.trim() ?? saved?.name ?? options.imported?.name;
    if ((name || undefined) !== transcript.getSessionName())
      transcript.appendSessionInfo(name || "");
    if (saved && options.name !== undefined) await catalog.rename(id, name || undefined);
    const entryIds = new Map(savedTree?.nativeToPi ?? imported?.nativeToPi);
    const nativeIds = new Map([...entryIds].map(([nativeId, entryId]) => [entryId, nativeId]));
    const events = new PiEvents(project, () => extensions?.runner);
    const queue: Record<Queue, QueuedInput[]> = { steer: [], followUp: [] };
    const nextTurnCustom: UserMessage[] = [];
    const contextOnlyCustom: UserMessage[] = [];
    const queueMode: Record<Queue, QueueMode> = {
      steer: "one-at-a-time",
      followUp: "one-at-a-time",
    };
    const toolsInProgress = new Map<
      string,
      { name: string; args: Record<string, unknown>; output: string }
    >();
    const getQueue = () => ({
      steering: queue.steer.flatMap(({ text }) => (text === undefined ? [] : [text])),
      followUp: queue.followUp.flatMap(({ text }) => (text === undefined ? [] : [text])),
    });
    const toImages = (attachments: readonly ContentBlock[]) => {
      const images = toPiContent(attachments).filter((part) => part.type === "image");
      return images.length === 0 ? undefined : images;
    };
    const reportQueue = () => events.emit({ type: "queue_update", ...getQueue() });
    const currentModel = () => selectModel(llm.models, selection.current);
    const getContextUsage = () => contextUsage(transcript, contextWindow());
    type Listener = (chunk: LlmStreamChunk) => void;
    let active:
      | {
          readonly controller: AbortController;
          readonly listener?: Listener;
          readonly done: PromiseWithResolvers<void>;
          readonly inputTasks: Set<Promise<unknown>>;
          readonly deferred: (() => Promise<void>)[];
          retryAttempt: number;
          firstRequest: boolean;
          continueAtBoundary?: boolean;
          requestTools?: readonly ToolDeclaration[];
          route?: ModelRoute;
          failedRequest?: PiAssistant;
          response?: AssistantMessage;
        }
      | undefined;
    const requestRoutes = new WeakMap<LlmRequest["messages"], ModelRoute>();
    let settling: typeof active;
    let retryWait: AbortController | undefined;
    let closing = false;
    let handlingCommand = false;
    let extensions: Awaited<ReturnType<typeof loadExtensions>>;
    let extensionBindings: Parameters<AgentSession["bindExtensions"]>[0] = {};
    let scopedModels: readonly ScopedModel[] = [];
    const cacheWarmer = new CacheWarmer(
      {
        streamSimple: (model, payload, options) =>
          extensions.modelRuntime.streamSimple(model, payload, options),
      },
      transcript,
      () => extensions.settings.getCacheWarmingMode(),
      (event) => extensions.runner.emitCacheWarmingDecision(event),
    );
    modelProviders.onRequest = (request) => {
      const { provider, model } = selection.current;
      const routed = active?.route?.model;
      if (
        !active ||
        request.options.sessionId !== id ||
        request.model.provider !== (routed?.provider ?? provider) ||
        request.model.id !== (routed?.id ?? model)
      ) {
        return;
      }
      const branchId = context.id;
      const prefix = transcript.getBranch();
      cacheWarmer.start(request, () => {
        if (
          closing ||
          context.id !== branchId ||
          selection.current.provider !== provider ||
          selection.current.model !== model
        )
          return false;
        const branch = transcript.getBranch();
        return (
          prefix.every((entry, index) => branch[index] === entry) &&
          !branch
            .slice(prefix.length)
            .some(({ type }) => type === "context_edit" || type === "compaction")
        );
      });
    };
    cacheWarmer.onWarmed = (entry) => {
      const native = sessionUsage(entry);
      context.pending.push(native);
      entryIds.set(native.id, entry.id);
      nativeIds.set(entry.id, native.id);
      events.emit({ type: "entry_appended", entry });
      rememberExtensionState();
    };
    const diagnostics: AgentSessionRuntimeDiagnostic[] = flagErrors.map((message) => ({
      type: "error",
      message,
    }));
    const retrySummary: RetrySummary = (start, signal, summarize) =>
      events.retrySummarization(
        start,
        modelProviders.toPiModel(currentModel()),
        extensions.settings.getRetrySettings(),
        signal,
        summarize,
      );
    const sessionCompaction = createSessionCompaction({
      get context() {
        return context;
      },
      contextSize: scope.get(ContextSizeService),
      get compaction() {
        return compaction;
      },
      transcript,
      events,
      entryIds,
      model: currentModel,
      settings: () => extensions.settings,
      runner: () => extensions.runner,
      retrySummary,
      agentSignal: () => active?.controller.signal,
      async stopAgent() {
        abort();
        await active?.done.promise;
      },
    });
    const sessionTree = createSessionTree({
      root,
      catalog,
      sessionId: id,
      transcript,
      entryIds,
      nativeIds,
      llm,
      getContext: () => context,
      switchContext(branchId) {
        scope.provideAll([
          createDescriptor(Context, { id: branchId }),
          createDescriptor(AgentLoop, { sessionId: id }),
          PiCompactionService,
        ]);
        applyCompactionSettings();
      },
      saved: savedTree,
      importedEntries: imported?.entries ?? [],
      getRunner: () => extensions.runner,
      getModel: currentModel,
      getReserveTokens: () => extensions.settings.getBranchSummarySettings().reserveTokens,
      retrySummary,
      isBusy: () =>
        active !== undefined ||
        settling !== undefined ||
        sessionCompaction.isCompacting ||
        runningBash.size > 0,
      async restoreTools() {
        cacheWarmer.cancel();
        extensions.restoreTools(readToolHistory(await history(), transcript.getBranch()));
      },
    });

    function applyCompactionSettings(): void {
      const model = currentModel();
      const settings = extensions.settings.getCompactionSettings({
        provider: model.provider,
        id: model.id,
      });
      compaction.autoEnabled = settings.enabled;
      compaction.keepRecentTokens = settings.keepRecentTokens;
      const budget =
        model.contextWindow > 0
          ? Math.max(0, model.contextWindow - settings.reserveTokens)
          : undefined;
      compaction.maxActiveTokens = isVirtualModel(modelProviders.toPiModel(model))
        ? Infinity
        : budget;
    }

    function contextWindow(): number {
      const model = modelProviders.toPiModel(currentModel());
      if (!isVirtualModel(model)) return model.contextWindow;
      const previous = findLatestResponse(transcript.buildSessionProjection().messages);
      const physical =
        active?.route?.model ??
        (previous && extensions?.modelRuntime.getPhysicalModel(previous.provider, previous.model));
      return physical?.contextWindow ?? model.contextWindow;
    }

    function abort(): void {
      cacheWarmer.cancel();
      active?.controller.abort();
      loop.abort();
    }

    function finishRetry(success: boolean, finalError?: string): void {
      if (!active?.retryAttempt) return;
      const attempt = active.retryAttempt;
      active.retryAttempt = 0;
      events.emit({ type: "auto_retry_end", attempt, success, finalError });
      rememberExtensionState();
    }

    function rememberSession(): Promise<void> {
      return catalog.remember({
        id,
        cwd: storedCwd,
        parent: parentSession,
        name: transcript.getSessionName(),
        createdAt,
        ...savedSelection(),
      });
    }

    function savedSelection() {
      const { provider, model, reasoning } = selection.current;
      return {
        provider,
        model,
        thinking:
          reasoning === false ? "off" : typeof reasoning === "string" ? reasoning : undefined,
      };
    }

    function applySelection(model: LlmModelInfo, reasoning: ModelSelection["reasoning"]): void {
      const previous = selection.current;
      const next = resolveThinking(model, reasoning);
      const changedModel = previous.model !== model.id || previous.provider !== model.provider;
      const changedThinking = previous.reasoning !== next;
      if (!changedModel && !changedThinking) return;
      selection.select({ ...previous, provider: model.provider, model: model.id, reasoning: next });
      if (changedModel) {
        cacheWarmer.cancel();
        transcript.appendModelChange(model.provider, model.id);
        applyCompactionSettings();
      }
      if (changedThinking) {
        const level = thinkingLevel(next);
        transcript.appendThinkingLevelChange(level);
        events.emit({ type: "thinking_level_changed", level });
        void extensions.runner.emit({
          type: "thinking_level_select",
          level,
          previousLevel: thinkingLevel(previous.reasoning),
        });
      }
      void catalog
        .saveSelection(id, savedSelection())
        .catch((error: unknown) => console.error(error));
    }

    async function switchModel(
      target: ScopedModel,
      source: "set" | "cycle",
      options?: ModelMutationOptions,
    ): Promise<void> {
      const previousModel = modelProviders.toPiModel(currentModel());
      const { provider, id } = target.model;
      const model = selectModel(llm.models, { provider, model: id });
      const level =
        target.thinkingLevel ??
        settings.getModelThinkingLevel(provider, id) ??
        settings.getDefaultThinkingLevel() ??
        thinkingLevel(selection.current.reasoning);
      applySelection(model, level);
      if (options?.persist) {
        settings.setDefaultModelAndProvider(provider, id);
        if (
          scopedModels.length > 0 &&
          !scopedModels.some(({ model }) => model.provider === provider && model.id === id)
        ) {
          scopedModels = [...scopedModels, { model: target.model }];
          const enabled = settings.getEnabledModels();
          const reference = `${provider}/${id}`;
          if (
            enabled?.length &&
            !enabled.some((pattern) => pattern.toLowerCase() === reference.toLowerCase())
          ) {
            settings.setEnabledModels([...enabled, reference]);
          }
        }
      }
      if (previousModel.provider !== provider || previousModel.id !== id) {
        await extensions.runner.emit({
          type: "model_select",
          model: modelProviders.toPiModel(model),
          previousModel,
          source,
        });
      }
    }

    function setModel(
      provider: string,
      modelId: string,
      options?: ModelMutationOptions,
    ): Promise<void> {
      const model = selectModel(llm.models, { provider, model: modelId });
      return switchModel({ model: modelProviders.toPiModel(model) }, "set", options);
    }

    async function cycleModel(
      direction: "forward" | "backward" = "forward",
      options?: ModelMutationOptions,
    ) {
      const available = extensions.modelRuntime.getAvailableSnapshot();
      const isScoped = scopedModels.length > 0;
      const choices = isScoped
        ? scopedModels.flatMap((entry) => {
            const model = available.find(
              (model) => model.provider === entry.model.provider && model.id === entry.model.id,
            );
            return model ? [{ ...entry, model }] : [];
          })
        : available.map((model) => ({ model }));
      const { provider, model } = selection.current;
      const index = choices.findIndex(
        (choice) => choice.model.provider === provider && choice.model.id === model,
      );
      if (!choices.length || (choices.length === 1 && index >= 0)) return undefined;
      const offset = direction === "forward" ? 1 : -1;
      const nextIndex =
        index < 0
          ? offset === 1
            ? 0
            : choices.length - 1
          : (index + offset + choices.length) % choices.length;
      const next = choices[nextIndex]!;
      await switchModel(next, "cycle", options);
      return {
        model: next.model,
        thinkingLevel: thinkingLevel(selection.current.reasoning),
        isScoped,
      };
    }

    function refreshSelectedModel(): void {
      const { provider, model, reasoning } = selection.current;
      const available = llm.models;
      const selected = available.find(
        (candidate) => candidate.provider === provider && candidate.id === model,
      );
      applySelection(selected ?? selectModel(available, {}), reasoning);
      applyCompactionSettings();
    }

    function setThinking(level: ThinkingLevel, options?: ModelMutationOptions): void {
      if (!thinkingLevels.includes(level)) throw new Error(`Invalid thinking level: ${level}`);
      if (options?.persist) settings.setDefaultThinkingLevel(level);
      applySelection(currentModel(), level);
    }

    function setSessionName(name: string): void {
      const normalized = name.trim() || undefined;
      if (normalized === transcript.getSessionName()) return;
      transcript.appendSessionInfo(name);
      void catalog.rename(id, normalized).catch((error: unknown) => console.error(error));
      const event = { type: "session_info_changed", name: normalized } as const;
      events.emit(event);
      void extensions.runner.emit(event).catch((error: unknown) => console.error(error));
    }

    function abortBash(): void {
      for (const controller of runningBash.keys()) controller.abort();
    }

    function recordBashResult(command: string, result: BashResult, options?: BashOptions): void {
      const message = bashMessage(
        {
          ...result,
          role: "bashExecution",
          command,
          timestamp: Date.now(),
          excludeFromContext: options?.excludeFromContext,
        },
        new MessageMeta().set(SupplementaryField, true),
      );
      if (loop.isRunning) pendingBash.push(message);
      else appendBashMessage(message);
      void rememberSession();
    }

    function appendBashMessage(message: UserMessage): void {
      context.pending.push(message);
      project(toPiMessages([message])[0]!, message.id);
    }

    function onToolUpdate(
      callId: string,
      result: Pick<PiToolResult, "content"> & Partial<PiToolResult>,
    ): void {
      const info = toolsInProgress.get(callId);
      if (!info) return;
      events.emit({
        type: "tool_execution_update",
        toolCallId: callId,
        toolName: info.name,
        args: info.args,
        partialResult: result,
      });
    }

    const history = () => readSessionHistory(context);

    function createUserMessage(text: string, attachments: readonly ContentBlock[]): UserMessage {
      const content = text ? [TextBlock.create({ text }), ...attachments] : attachments;
      const message = UserMessage.create({ content });
      stampMessage(message);
      return message;
    }

    async function normalizeUserMessage(
      text: string,
      attachments: readonly ContentBlock[],
    ): Promise<UserMessage> {
      const images = toImages(attachments);
      if (!images) return createUserMessage(text, attachments);
      const model = modelProviders.toPiModel(currentModel());
      const normalized = [];
      const hints: string[] = [];
      for (const image of images) {
        const result = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
          autoResizeImages: settings.getImageAutoResize(),
          resizeOptions: model.inputLimits?.images?.resize,
        });
        if (result.ok) {
          normalized.push({ type: "image" as const, mimeType: result.mimeType, data: result.data });
          hints.push(...result.hints);
        } else {
          hints.push(result.message);
        }
      }
      const content = hints.length > 0 ? `${text}\n\n${hints.join("\n")}` : text;
      return createUserMessage(content, replaceImages(attachments, normalized));
    }

    function takeQueuedInputs(name: Queue): readonly UserMessage[] | undefined {
      const entries = queue[name].splice(0, queueMode[name] === "all" ? queue[name].length : 1);
      if (entries.length === 0) return undefined;
      reportQueue();
      return entries.map(({ message }) => message);
    }

    function project(message: PiMessage, nativeId?: string): string | undefined {
      const existing = nativeId ? entryIds.get(nativeId) : undefined;
      if (existing) return existing;
      let entryId: string;
      if (message.role === "custom") {
        entryId = transcript.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );
      } else if (
        message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult" ||
        message.role === "bashExecution"
      ) {
        entryId = transcript.appendMessage(message);
      } else {
        return;
      }
      if (nativeId) {
        entryIds.set(nativeId, entryId);
        nativeIds.set(entryId, nativeId);
      }
      return entryId;
    }

    function projectExtensionEntry(native: ExtensionEntry) {
      if (entryIds.has(native.id)) return undefined;
      const data: unknown = native.dataJson === undefined ? undefined : JSON.parse(native.dataJson);
      const id = transcript.appendCustomEntry(native.customType, data);
      entryIds.set(native.id, id);
      nativeIds.set(id, native.id);
      return transcript.getEntry(id);
    }

    function restoreContextEdit(native: ContextEditMessage): void {
      if (entryIds.has(native.id) || !native.targetMessageId) return;
      const targetId = entryIds.get(native.targetMessageId);
      if (targetId) {
        const id = transcript.appendContextEdit(targetId, native.replacement);
        entryIds.set(native.id, id);
        nativeIds.set(id, native.id);
      }
    }

    function projectContextEdit(
      targetId: string,
      replacement: Parameters<SessionManager["appendContextEdit"]>[1],
      targetMessageId?: string,
    ) {
      const id = transcript.appendContextEdit(targetId, replacement);
      const entry = transcript.getEntry(id);
      if (entry?.type !== "context_edit") throw new Error("Context edit was not projected");
      const edit = contextEditMessage(entry, targetMessageId);
      entryIds.set(edit.id, id);
      nativeIds.set(id, edit.id);
      return { entry, edit };
    }

    function rememberExtensionState(): void {
      void rememberSession().catch((error: unknown) => console.error(error));
      void sessionTree.persist().catch((error: unknown) => console.error(error));
    }

    const appendEntry: ExtensionActions["appendEntry"] = (customType, data) => {
      const native = extensionEntry(customType, data);
      context.pending.push(native);
      const entry = projectExtensionEntry(native);
      if (entry) events.emit({ type: "entry_appended", entry });
      rememberExtensionState();
    };

    function appendExtensionMessage(native: UserMessage): void {
      context.pending.push(native);
      for (const message of toPiMessages([native])) events.publishMessage(message, native.id);
      rememberExtensionState();
    }

    const sendMessage: ExtensionActions["sendMessage"] = (message, options) => {
      const runActive = active !== undefined;
      const input: PiCustomMessage = {
        ...message,
        role: "custom",
        content: message.content ?? [],
        timestamp: Date.now(),
      };
      if (!runActive && options?.triggerTurn && options.deliverAs !== "nextTurn") {
        void runExtensionTurn({ kind: "custom", message: input });
        return;
      }
      const supplementary =
        options?.deliverAs === "nextTurn" || !runActive || options?.triggerTurn === false;
      const native = customMessage(input, supplementary);
      if (options?.deliverAs === "nextTurn") nextTurnCustom.push(native);
      else if (!runActive) appendExtensionMessage(native);
      else if (supplementary) contextOnlyCustom.push(native);
      else
        queue[options?.deliverAs === "followUp" ? "followUp" : "steer"].push({ message: native });
    };

    function reportSendError(event: string, error: unknown): void {
      extensions.runner.emitError({
        extensionPath: "<runtime>",
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    async function runExtensionTurn(input: TurnInput): Promise<void> {
      if (closing) return;
      const current = active ?? settling;
      if (current) {
        current.deferred.push(() => runExtensionTurn(input));
        return;
      }
      try {
        await runPrompt(input);
      } catch (error) {
        reportSendError(input.kind === "custom" ? "send_message" : "send_user_message", error);
      }
    }

    const sendUserMessage: ExtensionActions["sendUserMessage"] = (content, options) => {
      const blocks = fromPiContent(content);
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const attachments = blocks.filter((block) => block instanceof ImageBlock);
      if (active) {
        if (options?.deliverAs) {
          void enqueueUser(
            options.deliverAs,
            text,
            attachments,
            "extension",
            options.expandPromptTemplates ?? false,
          ).catch((error: unknown) => reportSendError("send_user_message", error));
        } else {
          reportSendError(
            "send_user_message",
            new Error("Specify steer or followUp while the agent is running"),
          );
        }
        return;
      }
      if (options?.expandPromptTemplates) {
        const send = async () => {
          await prompt(text, attachments, undefined, undefined, "extension").catch(
            (error: unknown) => reportSendError("send_user_message", error),
          );
        };
        if (settling) settling.deferred.push(send);
        else void send();
        return;
      }
      void runExtensionTurn({ kind: "user", text, attachments, source: "extension" });
    };

    function flushContextOnlyCustom(resume = false): void {
      for (const native of contextOnlyCustom.splice(0)) {
        if (resume) native.meta.set(SupplementaryField, false);
        appendExtensionMessage(native);
      }
    }

    async function drainInputTasks(): Promise<void> {
      const tasks = active?.inputTasks;
      while (tasks?.size) await Promise.allSettled(tasks);
    }

    async function runBoundary(event: BoundaryEvent, signal: AbortSignal): Promise<boolean> {
      const failedTurn = event.type === "turn_end" && event.outcome !== "completed";
      const turn = active;
      let history: readonly Message[] | undefined;
      let continueFromTools = false;
      const resume = await dispatchBoundary(
        extensions.runner,
        transcript,
        event,
        async () => {
          await drainInputTasks();
          return toPiMessages([
            ...queue.steer.map(({ message }) => message),
            ...queue.followUp.map(({ message }) => message),
            ...contextOnlyCustom,
          ]);
        },
        async (draft, resume) => {
          if (draft.type === "custom") {
            appendEntry(draft.customType, draft.data);
            return;
          }
          if (draft.type === "compaction") {
            if (event.type === "turn_end" && event.toolResults.length > 0) {
              continueFromTools ||= loop.shouldSend();
            }
            const entry = await sessionCompaction.commitBoundary(draft);
            events.emit({ type: "entry_appended", entry });
            rememberExtensionState();
            return;
          }
          if (draft.type === "context_edit") {
            history ??= await readSessionHistory(context);
            const matches = (message: Message) => entryIds.get(message.id) === draft.targetId;
            const target = context.pending.findLast(matches) ?? history.findLast(matches);
            const { entry, edit } = projectContextEdit(
              draft.targetId,
              draft.replacement,
              target?.id,
            );
            context.pending.push(edit);
            events.emit({ type: "entry_appended", entry });
            rememberExtensionState();
            return;
          }
          const projected = { ...draft, role: "custom" as const, timestamp: Date.now() };
          const native = customMessage(projected, !resume || signal.aborted || failedTurn);
          context.pending.push(native);
          const id = project(projected, native.id);
          const entry = id && transcript.getEntry(id);
          if (entry) events.emit({ type: "entry_appended", entry });
          rememberExtensionState();
        },
      );
      if (turn && (resume || continueFromTools) && !failedTurn && !signal.aborted) {
        turn.continueAtBoundary = true;
      }
      return resume;
    }

    const summaries = await sessionCompaction.storedSummaries();
    for (const native of stored) {
      if (native instanceof ExtensionEntry) projectExtensionEntry(native);
      if (native instanceof ContextEditMessage) restoreContextEdit(native);
      if (native instanceof SessionUsage && !entryIds.has(native.id)) {
        const entry = transcript.appendUsage(
          native.kind,
          native.provider,
          native.model,
          native.usage,
          native.note,
        );
        entryIds.set(native.id, entry.id);
        nativeIds.set(entry.id, native.id);
      }
      for (const message of toPiMessages([native])) {
        if (
          context.batchCount > 0 ||
          message.role === "custom" ||
          message.role === "bashExecution"
        ) {
          project(message, native.id);
        }
      }
      for (const item of summaries) {
        if (item.projection.afterMessageId === native.id)
          sessionCompaction.append(item.summary, item.projection);
      }
    }
    for (const item of summaries) {
      const anchor = item.projection.afterMessageId;
      if (!anchor || !entryIds.has(anchor)) sessionCompaction.append(item.summary, item.projection);
    }
    function sessionNameAt(leafId: string | null): string | undefined {
      for (const entry of leafId === null ? [] : transcript.getBranch(leafId).reverse()) {
        if (entry.type === "session_info") return entry.name?.trim() || undefined;
      }
      return undefined;
    }

    async function fork(entryId: string, position: "before" | "at") {
      const selected = transcript.getEntry(entryId);
      if (
        !selected ||
        (position === "before" && (selected.type !== "message" || selected.message.role !== "user"))
      ) {
        throw new Error("Invalid entry ID for forking");
      }
      const selectedText =
        position === "before" && selected.type === "message" && selected.message.role === "user"
          ? extractText(fromPiContent(selected.message.content))
          : undefined;
      if (position === "at" && entryId === transcript.getLeafId()) {
        return { ...(await context.fork()), selectedText, name: sessionNameAt(selected.id) };
      }
      const leaf = position === "at" ? selected.id : selected.parentId;
      return { id: await sessionTree.forkAt(leaf), selectedText, name: sessionNameAt(leaf) };
    }

    async function settle(): Promise<void> {
      abort();
      abortBash();
      sessionCompaction.abort();
      sessionTree.abort();
      await waitForAgent();
      await Promise.allSettled(runningBash.values());
      await sessionCompaction.waitForIdle();
      await sessionTree.waitForIdle();
      await sqlite.flush();
    }

    async function waitForAgent(): Promise<void> {
      let current = active ?? settling;
      while (current) {
        await current.done.promise;
        current = active ?? settling;
      }
    }

    function enqueueUser(
      name: Queue,
      text: string,
      attachments: readonly ContentBlock[],
      source?: "extension",
      expandPromptTemplates = true,
    ) {
      const tasks = active?.inputTasks;
      const task = (async () => {
        const input = await extensions?.input(
          text,
          toImages(attachments),
          active ? name : undefined,
          source,
        );
        if (input?.action === "handled") return "handled" as const;
        if (input?.action === "transform") {
          if (input.images) attachments = replaceImages(attachments, input.images);
          text = input.text;
        }
        if (expandPromptTemplates) text = extensions.expandPrompt(text);
        queue[name].push({ text, message: await normalizeUserMessage(text, attachments) });
        reportQueue();
        return "queued" as const;
      })();
      tasks?.add(task);
      const removeTask = () => tasks?.delete(task);
      void task.then(removeTask, removeTask);
      return task;
    }

    function checkCanStart(): void {
      if (closing) throw new Error("Session is closing");
      if (sessionCompaction.isCompacting || sessionTree.isNavigating)
        throw new Error("Agent is compacting");
      if (active !== undefined || settling !== undefined)
        throw new Error("Agent is already running");
    }

    async function prompt(
      text: string,
      attachments: readonly ContentBlock[] = [],
      listener?: Listener,
      preflight?: PromptOptions["preflightResult"],
      source?: "extension",
    ): Promise<string> {
      checkCanStart();
      if (handlingCommand) throw new Error("An extension command is already running");
      if (text.startsWith("/")) {
        handlingCommand = true;
        try {
          if (await extensions?.command(text)) {
            preflight?.("handled");
            await waitForAgent();
            return "";
          }
        } finally {
          handlingCommand = false;
        }
      }
      return runPrompt(
        { kind: "user", text, attachments, source, expandPromptTemplates: true },
        listener,
        preflight,
      );
    }

    async function retryActivity(
      failed: PersistedTurn,
      settings: ReturnType<SettingsManager["getRetrySettings"]>,
      signal: AbortSignal,
    ): Promise<readonly UserMessage[] | undefined> {
      const turn = active;
      if (!turn || signal.aborted) return undefined;
      const attempt = ++turn.retryAttempt;
      const delayMs = retryDelayMs(settings, attempt);
      const controller = new AbortController();
      retryWait = controller;
      const waitSignal = AbortSignal.any([signal, controller.signal]);
      try {
        events.emit({
          type: "auto_retry_start",
          attempt,
          maxAttempts: settings.maxRetries,
          delayMs,
          errorMessage: failed.message.errorMessage ?? "Unknown error",
        });
        const native = fromPiAssistant(failed.message);
        native.meta.set(SupplementaryField, true);
        const { entry, edit } = projectContextEdit(failed.messageEntryId, null, native.id);
        entryIds.set(native.id, failed.messageEntryId);
        nativeIds.set(failed.messageEntryId, native.id);
        context.pending.push(native, edit);
        events.emit({ type: "entry_appended", entry });
        rememberExtensionState();
        await delay(delayMs, undefined, { signal: waitSignal });
      } catch (error) {
        if (!waitSignal.aborted) throw error;
        finishRetry(false, "Retry cancelled");
        return undefined;
      } finally {
        retryWait = undefined;
      }
      await drainInputTasks();
      if (signal.aborted) return undefined;
      turn.failedRequest = failed.message;
      turn.continueAtBoundary = true;
      return takeQueuedInputs("steer") ?? [];
    }

    async function runActivity(
      inputs: readonly UserMessage[],
      signal: AbortSignal,
    ): Promise<{
      aborted: boolean;
      failure?: Error;
      retryInputs?: readonly UserMessage[];
      reported: boolean;
    }> {
      await events.start();
      let aborted = signal.aborted;
      let failure: Error | undefined;
      let failed: PersistedTurn | undefined;
      let retrySettings: ReturnType<SettingsManager["getRetrySettings"]> | undefined;
      try {
        if (!signal.aborted) await prepareInputs(inputs, signal);
        const reason = signal.aborted ? "aborted" : await loop.run();
        aborted = reason === "aborted";
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        flushContextOnlyCustom();
        for (const message of pendingBash.splice(0)) appendBashMessage(message);
        extensions.finishActivity();
        const stopped = aborted || signal.aborted;
        if (stopped || failure) cacheWarmer.cancel();
        await events.end(
          stopped,
          failure?.message,
          async (turn) => {
            if (!stopped && failure && turn.message.stopReason === "error") failed = turn;
            await runBoundary(
              {
                ...turn,
                type: "turn_end",
                outcome: stopped ? "aborted" : failure ? "error" : "completed",
              },
              signal,
            );
            flushContextOnlyCustom();
          },
          () => {
            if (
              !failed ||
              signal.aborted ||
              !active ||
              isContextOverflow(failed.message, contextWindow()) ||
              !isRetryableAssistantError(failed.message)
            )
              return false;
            const settings = extensions.settings.getRetrySettings();
            if (!settings.enabled || active.retryAttempt >= settings.maxRetries) return false;
            retrySettings = settings;
            return true;
          },
        );
        await events.flush();
      }
      const retryInputs =
        failed && retrySettings ? await retryActivity(failed, retrySettings, signal) : undefined;
      aborted ||= signal.aborted;
      if (!retryInputs) {
        if (active) active.failedRequest = undefined;
        finishRetry(false, aborted ? "Retry cancelled" : failure?.message);
      }
      return { aborted, failure, retryInputs, reported: failed !== undefined };
    }

    async function resumeAfterActivity(
      signal: AbortSignal,
      failure?: Error,
    ): Promise<readonly UserMessage[] | undefined> {
      await drainInputTasks();
      if (signal.aborted) return undefined;
      const waiting = takeQueuedInputs("steer") ?? takeQueuedInputs("followUp");
      if (waiting) {
        flushContextOnlyCustom();
        return waiting;
      }
      const resume = await runBoundary(
        {
          type: "agent_before_settle",
          outcome: failure ? "error" : "completed",
        },
        signal,
      );
      await drainInputTasks();
      flushContextOnlyCustom(resume && !signal.aborted);
      if (signal.aborted) return undefined;
      return (
        takeQueuedInputs("steer") ??
        takeQueuedInputs("followUp") ??
        (resume && loop.shouldSend() ? [] : undefined)
      );
    }

    async function runPrompt(
      input: TurnInput,
      listener?: Listener,
      preflight?: PromptOptions["preflightResult"],
    ): Promise<string> {
      checkCanStart();
      const turn: NonNullable<typeof active> = {
        listener,
        controller: new AbortController(),
        done: Promise.withResolvers<void>(),
        inputTasks: new Set(),
        deferred: [],
        retryAttempt: 0,
        firstRequest: true,
      };
      active = turn;
      const { signal } = turn.controller;
      let started = false;
      let aborted = false;
      try {
        let trigger: Parameters<typeof extensions.prepareRun>[0];
        let userAttachments: readonly ContentBlock[] = [];
        if (input.kind === "custom") {
          trigger = { messageType: "custom", message: input.message };
        } else {
          let { text, attachments } = input;
          const transformed = await extensions?.input(
            text,
            toImages(attachments),
            undefined,
            input.source,
          );
          if (transformed?.action === "handled") {
            preflight?.("handled");
            return "";
          }
          if (transformed?.action === "transform") {
            if (transformed.images) attachments = replaceImages(attachments, transformed.images);
            text = transformed.text;
          }
          if (input.expandPromptTemplates) text = extensions.expandPrompt(text);
          if (!text && attachments.length === 0) {
            preflight?.("handled");
            return "";
          }
          trigger = { messageType: "user", prompt: text, images: toImages(attachments) };
          userAttachments = attachments;
        }
        await rememberSession();
        if (signal.aborted) {
          preflight?.("handled");
          return "";
        }
        const messages = await extensions.prepareRun(trigger, signal);
        const opening =
          trigger.messageType === "custom"
            ? customMessage(trigger.message, false)
            : await normalizeUserMessage(trigger.prompt, userAttachments);
        preflight?.("started");
        started = true;
        let inputs: readonly UserMessage[] | undefined = [];
        if (!signal.aborted) {
          cacheWarmer.cancel();
          flushContextOnlyCustom();
          inputs = [
            opening,
            ...nextTurnCustom.splice(0),
            ...messages.map((message) =>
              customMessage({
                ...message,
                role: "custom",
                content: message.content ?? [],
                timestamp: Date.now(),
              }),
            ),
          ];
        }
        let activity: Awaited<ReturnType<typeof runActivity>>;
        do {
          activity = await runActivity(inputs, signal);
          aborted = activity.aborted;
          inputs = aborted
            ? undefined
            : (activity.retryInputs ?? (await resumeAfterActivity(signal, activity.failure)));
        } while (inputs);
        // A stopReason=error assistant message was already rendered from the transcript.
        if (
          activity.failure &&
          !activity.reported &&
          !aborted &&
          !signal.aborted
        )
          throw activity.failure;
        return turn.response ? extractText(turn.response.content) : "";
      } finally {
        try {
          flushContextOnlyCustom();
        } finally {
          extensions.finishRun();
          active = undefined;
          if (aborted || signal.aborted) turn.deferred.length = 0;
          settling = turn;
          try {
            if (started) {
              await sessionTree.persist().catch((error: unknown) => console.error(error));
              cacheWarmer.onAgentSettled();
              await events.settle(aborted || signal.aborted);
            }
          } finally {
            settling = undefined;
            turn.done.resolve();
          }
        }
        for (const send of turn.deferred) await send();
        if (started) await events.flush();
      }
    }

    function systemInputMessages(
      message: Extract<PiMessage, { role: "system" }>,
      leading: boolean,
    ): readonly Message[] {
      const { sections, ...base } = message;
      const changes = [
        ...fromPiMessage(base, leading ? 0 : 1, true),
        ...Object.entries(sections ?? {}).map(([name, text]) =>
          createPiPromptSection(name, text ?? undefined),
        ),
      ];
      if (!changes.some((native) => native instanceof SystemMessage)) {
        changes.push(SystemMessage.create({ content: [] }));
      }
      for (const native of changes) stampImportedMessage(native, message);
      return changes;
    }

    async function prepareSystemInput(
      prepared: PreparedTurnInput[],
      sections: Record<string, string | null> | undefined,
      leading: boolean,
    ): Promise<readonly ToolDeclaration[] | undefined> {
      const previous = [
        ...toolSystemMessages(transcript.getBranch()),
        ...prepared.flatMap(({ edited }) => (edited.role === "system" ? [edited] : [])),
      ];
      const desired = extensions.modelDeclarations();
      const desiredPi = desired.filter((tool) => tool instanceof FunctionToolDeclaration).map(toPiTool);
      const { toolsAdded, toolsRemoved } = getToolStateChanges(getCurrentTools(previous), desiredPi);
      if (!sections && !toolsAdded.length && !toolsRemoved.length) return undefined;
      const original = {
        role: "system",
        content: "",
        timestamp: Date.now(),
        ...(sections ? { sections } : {}),
        ...(toolsAdded.length ? { toolsAdded } : {}),
        ...(toolsRemoved.length ? { toolsRemoved } : {}),
      } as const;
      const edited = await events.editTurnInput(original);
      if (edited.role !== "system") return undefined;
      prepared.push({ original, edited, messages: systemInputMessages(edited, leading) });
      const declared = getCurrentTools([...previous, edited]);
      const difference = getToolStateChanges(desiredPi, declared);
      return difference.toolsAdded.length || difference.toolsRemoved.length
        ? declared.map(fromPiTool)
        : undefined;
    }

    async function prepareInputs(
      inputs: readonly UserMessage[],
      signal: AbortSignal,
    ): Promise<void> {
      const run = active;
      if (!run || signal.aborted) return;
      await events.prepareTurn();
      if (signal.aborted) return;
      const previous = await readSessionHistory(context, signal);
      const updates = run.retryAttempt === 0 ? prepareSystemPrompt(previous) : [];
      const plannedSections = Object.fromEntries(
        updates.flatMap((message) =>
          message.sectionId === undefined
            ? []
            : [
                [
                  message.sectionId,
                  message.content.length ? extractText(message.content) : null,
                ] as const,
              ],
        ),
      );
      events.startTurn(modelProviders.toPiModel(currentModel()));
      const prepared: PreparedTurnInput[] = [];
      let tools = await prepareSystemInput(
        prepared,
        updates.length ? plannedSections : undefined,
        previous.length === 0,
      );
      for (const native of inputs) {
        if (signal.aborted) return;
        const [original] = toPiMessages([native]);
        if (original?.role !== "user" && original?.role !== "custom") {
          throw new Error("Expected a Pi user or custom input");
        }
        const edited = await events.editTurnInput(original);
        if (edited.role !== "user" && edited.role !== "custom")
          throw new Error("Unexpected Pi input role");
        prepared.push({
          original,
          edited,
          messages: [edited === original ? native : replacePiUserMessage(native, edited)],
        });
      }
      // Pi declares tools again after the opening messages have passed through message_end.
      if (signal.aborted) return;
      if (run.firstRequest) tools = await prepareSystemInput(prepared, undefined, false);
      if (signal.aborted) return;

      run.firstRequest = false;
      run.requestTools = tools;
      if (prepared.length > 0)
        context.pending.push(...prepared.flatMap(({ messages }) => messages));
      for (const { edited, messages } of prepared) {
        const id = project(edited, messages[0]?.id);
        if (id === undefined) continue;
        for (const native of messages) {
          entryIds.set(native.id, id);
          nativeIds.set(id, native.id);
        }
      }
      for (const { original, edited } of prepared) events.publishTurnInput(original, edited);
      await events.flush();
    }

    function selectRequestModel(request: LlmRequest): LlmRequest {
      const route = requestRoutes.get(request.messages);
      if (!route) return request;
      requestRoutes.delete(request.messages);
      events.setRequestModel(route.model);
      const limit = route.model.maxTokens;
      return {
        ...request,
        provider: route.model.provider,
        model: route.model.id,
        reasoning: route.thinkingLevel === "off" ? false : route.thinkingLevel,
        maxTokens:
          request.maxTokens && limit > 0 ? Math.min(request.maxTokens, limit) : request.maxTokens,
      };
    }

    function projectRequest(raw: LlmInputPayload) {
      const tools = active?.requestTools ?? raw.tools;
      const payload = {
        ...raw,
        messages: projectModelMessages(raw.messages),
        tools: extensions ? extensions.projectTools(tools) : tools,
      };
      const visible = new Set(payload.tools?.map(({ name }) => name));
      return {
        payload,
        sources: {
          getEntry: (messageId: string) => {
            const id = entryIds.get(messageId);
            return id ? transcript.getEntry(id) : undefined;
          },
          hiddenDeclarations: new Set(
            tools?.filter(({ name }) => !visible.has(name)).map(({ name }) => name),
          ),
        },
      };
    }

    async function prepareVirtualRoute({
      payload,
      sources,
    }: ReturnType<typeof projectRequest>): Promise<boolean> {
      const run = active;
      if (!run) return false;
      const model = modelProviders.toPiModel(currentModel());
      if (!isVirtualModel(model)) return false;
      const { signal } = run.controller;
      const messages = projectPiRequestMessages(payload, sources);
      const response = messages.findLastIndex(({ role }) => role === "assistant");
      const userTurn = messages.slice(response + 1).some(({ role }) => role === "user");
      const state = getVirtualModelState(transcript.getBranch(), model.provider, model.id);
      const failed = run.failedRequest;
      run.failedRequest = undefined;
      const route = await extensions.modelRuntime.resolveModel(model, convertToLlm(messages), {
        reason: failed ? "retry" : userTurn ? "user" : "continuation",
        thinkingLevel: thinkingLevel(selection.current.reasoning),
        signal,
        state,
        failed,
      });
      signal.throwIfAborted();
      run.route = route;
      if (route.state !== undefined && route.state !== state) {
        appendEntry(VIRTUAL_MODEL_STATE_ENTRY, {
          provider: model.provider,
          modelId: model.id,
          state: route.state,
        });
      }

      const settings = extensions.settings.getCompactionSettings({
        provider: route.model.provider,
        id: route.model.id,
      });
      compaction.autoEnabled = settings.enabled;
      compaction.keepRecentTokens = settings.keepRecentTokens;
      const budget = Math.max(0, route.model.contextWindow - settings.reserveTokens);
      if (
        !settings.enabled ||
        route.model.contextWindow <= 0 ||
        context.batchCount < 2 ||
        (await compaction.estimateActiveSize()) <= budget
      )
        return false;
      return (await compaction.compact(undefined, { reason: "threshold", signal })) !== undefined;
    }

    scope.setup(() => {
      context = scope.get(Context);
      loop = scope.get(AgentLoop);
      compaction = scope.get(PiCompactionService);
      compaction.backgroundTokens = 0;
      compaction.hooks.run.use(sessionCompaction.run);
      compaction.hooks.compact.use((input, next) => sessionCompaction.prepare(input, next));
      loop.hooks.shouldSend.use((input, next) => active?.continueAtBoundary || next(input));
      loop.hooks.handleError.use(async (error, next) => {
        await next(error);
        if (active) await prepareInputs([], active.controller.signal);
      });
      loop.hooks.transformContext.use(async (input, next) => {
        if (active) {
          active.continueAtBoundary = false;
          active.route = undefined;
        }
        let projected = projectRequest(await next(input));
        if (!extensions) return projected.payload;
        if (await prepareVirtualRoute(projected)) projected = projectRequest(await next(input));
        const request = await transformExtensionContext(
          extensions.runner,
          projected.payload,
          projected.sources,
        );
        const systemPrompt = extensions.forceSystemPrompt;
        const output =
          systemPrompt === undefined
            ? request
            : {
                ...request,
                systemPrompt,
                messages: request.messages.filter((message) => !(message instanceof SystemMessage)),
              };
        if (active?.route) requestRoutes.set(output.messages, active.route);
        return output;
      });
      loop.hooks.handleOutput.use(async (input, next) => {
        const response = await events.finishMessage(input.response);
        finishRetry(true);
        if (active !== undefined) active.response = response.message;
        if (response.message !== input.response.message) {
          const index = context.pending.indexOf(input.response.message);
          if (index !== -1) context.pending[index] = response.message;
        }
        await next({ ...input, response });
        const ids = new Set(
          response.message.content
            .filter((block) => block instanceof ToolCallBlock)
            .map((block) => block.id),
        );
        const results = context.pending.filter(
          (message): message is ToolResultMessage =>
            message instanceof ToolResultMessage && ids.has(message.toolCallId),
        );
        let resume = false;
        await events.endTurn(
          results,
          async (turn) => {
            resume = await runBoundary(
              {
                ...turn,
                type: "turn_end",
                outcome: input.signal.aborted ? "aborted" : "completed",
              },
              input.signal,
            );
          },
          (before, after) => {
            const index = context.pending.indexOf(before);
            if (index !== -1) context.pending[index] = after;
          },
        );
        await drainInputTasks();
        flushContextOnlyCustom(resume && !input.signal.aborted);
        await events.flush();
        extensions?.refreshPromptTools();
        if (!input.signal.aborted) {
          const queued =
            takeQueuedInputs("steer") ??
            (input.response.stopReason === "stop" ? takeQueuedInputs("followUp") : undefined);
          if (queued || loop.shouldSend()) await prepareInputs(queued ?? [], input.signal);
        }
      });
      prepareSystemPrompt = preset.setup(() => extensions?.systemPromptSections() ?? {}, {
        automaticPromptUpdates: false,
        registerTools: false,
      });
      loop.hooks.streamChunk.use((chunk, next) => {
        next(chunk);
        if (active) {
          events.chunk(chunk);
          if (chunk.type === "finish" && chunk.response.stopReason === "error") {
            const [message] = toPiMessages([chunk.response.message]);
            if (message?.role === "assistant") active.failedRequest = message;
          }
        }
        active?.listener?.(chunk);
      });
    });
    scope.run(() => {
      toolCall.hooks.execute.use(async ({ call }, next) => {
        if (!active || extensions?.isNestedToolCall(call.id)) return next();
        const args = parseToolInput(call.arguments) ?? {};
        const info = { name: call.name, args, output: "" };
        const start = performance.now();
        toolsInProgress.set(call.id, info);
        events.emit({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args,
        });
        await events.flushExtensionEvents();
        try {
          const result = await next();
          stampMessage(result);
          events.emit({
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result: { content: toPiContent(result.content), ...readToolResultData(result) },
            isError: result.isError ?? false,
            durationMs: Math.round(performance.now() - start),
          });
          await events.flushExtensionEvents();
          return result;
        } finally {
          toolsInProgress.delete(call.id);
        }
      });
      toolCall.hooks.streamOutput.use(({ callId, delta }, next) => {
        next();
        const info = toolsInProgress.get(callId);
        if (!info) return;
        info.output = truncateTail(info.output + delta).content;
        onToolUpdate(callId, { content: [{ type: "text", text: info.output }] });
      });
    });
    const extensionOptions = {
      ...options.extensions,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      transcript,
      settings,
      resources,
      appendEntry,
      sendMessage,
      sendUserMessage,
      onToolUpdate,
      onNestedToolEvent: (event: Parameters<typeof events.emit>[0]) => events.emit(event),
      abort,
      async compact(customInstructions?: string) {
        if (sessionTree.isNavigating)
          throw new Error("Wait for the current tree navigation to finish.");
        return sessionCompaction.compact(customInstructions);
      },
      setSessionName,
      setModel,
      getScopedModels: () => scopedModels,
      getContextUsage,
      hasNativeCredentials: (provider: string) =>
        provider === "deepseek" &&
        Boolean(deepSeekKey(options.extensions.agentDir, scope.get(PiRuntimeApiKey))),
      hasPendingMessages: () => queue.steer.length > 0 || queue.followUp.length > 0,
      onModelsChange: refreshSelectedModel,
      setThinking,
      getThinking: () => thinkingLevel(selection.current.reasoning),
    };
    extensions = await loadExtensions(scope, {
      ...extensionOptions,
      toolHistory: readToolHistory(stored, transcript.getBranch()),
      startReason: options.startReason ?? (context.batchCount > 0 ? "resume" : "startup"),
    });
    const runtimeKey = scope.get(PiRuntimeApiKey);
    const previousProvider = saved?.model_provider ?? options.imported?.model?.provider;
    const previousModel = saved?.model_id ?? options.imported?.model?.model;
    const runtime = extensions.modelRuntime;
    const available = runtime.getAvailableSnapshot();
    const known = new Map(
      modelProviders.knownModels().map((model) => [`${model.provider}\0${model.id}`, model]),
    );
    for (const model of available) known.set(`${model.provider}\0${model.id}`, model);
    const resolver = modelResolverCatalog(available, [...known.values()], (provider) =>
      runtime.hasConfiguredAuth(provider),
    );
    const patterns = options.modelPatterns ?? settings.getEnabledModels();
    if (patterns?.length) {
      const resolved = await resolveModelScopeWithDiagnostics([...patterns], resolver);
      scopedModels = resolved.scopedModels;
      diagnostics.push(...resolved.diagnostics);
    }
    const explicitThinking = thinkingLevels.find((level) => level === options.thinking);
    if (options.thinking !== undefined && explicitThinking === undefined) {
      diagnostics.push({
        type: "warning",
        message: `Invalid thinking level "${options.thinking}". Valid values: ${thinkingLevels.join(", ")}`,
      });
    }
    const resolved = resolveCliModel({
      cliProvider: options.provider,
      cliModel: options.model,
      cliThinking: explicitThinking,
      inlineApiKey: Boolean(runtimeKey.key),
      modelRuntime: resolver,
    });
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.model && !known.has(`${resolved.model.provider}\0${resolved.model.id}`)) {
      throw new Error(`Model not found: ${resolved.model.provider}/${resolved.model.id}`);
    }
    if (resolved.warning) diagnostics.push({ type: "warning", message: resolved.warning });
    const savedModel = available.find(
      (model) => model.provider === previousProvider && model.id === previousModel,
    );
    const retainedModel =
      options.retainSelection === undefined
        ? undefined
        : available.find(
            (model) =>
              model.provider === options.retainSelection!.provider &&
              model.id === options.retainSelection!.model,
          );
    const defaultModel = available.find(
      (model) =>
        model.provider === settings.getDefaultProvider() && model.id === settings.getDefaultModel(),
    );
    const defaultScope =
      scopedModels.find(
        ({ model }) => model.id === defaultModel?.id && model.provider === defaultModel?.provider,
      ) ?? scopedModels[0];
    const preferred =
      resolved.model ??
      retainedModel ??
      savedModel ??
      defaultScope?.model ??
      defaultModel ??
      available[0];
    if (!preferred) throw new NoModelsAvailableError();
    if (runtimeKey.key && runtimeKey.provider === undefined) {
      if (!resolved.model && (savedModel || !defaultScope)) {
        throw new Error(
          "--api-key requires a model to be specified via --model, --provider/--model, or --models",
        );
      }
      runtimeKey.provider = preferred.provider;
      await runtimeKey.apply(runtime);
    }
    const model = llm.models.find(
      (model) => model.provider === preferred.provider && model.id === preferred.id,
    );
    if (!model) throw new Error(`No API key for ${preferred.provider}/${preferred.id}`);
    const scopedThinking = resolved.model || savedModel ? undefined : defaultScope?.thinkingLevel;
    const retainedThinking = retainedModel ? options.retainSelection!.thinking : undefined;
    const reasoning = resolveThinking(
      model,
      explicitThinking ??
        resolved.thinkingLevel ??
        retainedThinking ??
        scopedThinking ??
        saved?.thinking ??
        options.imported?.thinking ??
        settings.getModelThinkingLevel(model.provider, model.id) ??
        settings.getDefaultThinkingLevel(),
    );
    selection.select({ provider: model.provider, model: model.id, reasoning });
    const restored = transcript.buildSessionContext();
    if (restored.model?.provider !== model.provider || restored.model?.modelId !== model.id) {
      transcript.appendModelChange(model.provider, model.id);
    }
    const initialThinking = thinkingLevel(reasoning);
    if (restored.thinkingLevel !== initialThinking)
      transcript.appendThinkingLevelChange(initialThinking);
    applyCompactionSettings();
    // Pi defers a forked session file until it holds a user or assistant message,
    // so an empty /fork stays out of --continue and the picker.
    const forkedConversation =
      options.startReason === "fork" &&
      transcript
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant"),
        );
    if (options.imported) await rememberSession();
    else if (forkedConversation) {
      await sessionTree.persist();
      await rememberSession();
    } else if (
      saved &&
      (options.model !== undefined ||
        options.provider !== undefined ||
        options.thinking !== undefined)
    ) {
      await catalog.saveSelection(id, savedSelection());
    }

    return {
      id,
      cwd: options.cwd,
      persisted: options.database !== ":memory:",
      sessionFile: options.database === ":memory:" ? undefined : options.database,
      transcript,
      events,
      getContextUsage,
      get model() {
        return currentModel();
      },
      toPiModel: (model: LlmModelInfo) => modelProviders.toPiModel(model),
      get models() {
        return llm.models;
      },
      get reasoning() {
        return selection.current.reasoning;
      },
      get thinkingLevel() {
        return thinkingLevel(selection.current.reasoning);
      },
      get signal() {
        return active?.controller.signal;
      },
      get isRunning() {
        return active !== undefined;
      },
      get isRetrying() {
        return retryWait !== undefined;
      },
      get retryAttempt() {
        return active?.retryAttempt ?? 0;
      },
      get isCompacting() {
        return sessionCompaction.isCompacting || sessionTree.isNavigating;
      },
      get autoCompactionEnabled() {
        return compaction.autoEnabled;
      },
      get cacheWarmingStatus() {
        return cacheWarmer.status;
      },
      get isBashRunning() {
        return runningBash.size > 0;
      },
      get queueMode() {
        return queueMode;
      },
      get pendingMessageCount() {
        const pending = getQueue();
        return pending.steering.length + pending.followUp.length;
      },
      get extensions() {
        return extensions;
      },
      get scopedModels() {
        return scopedModels;
      },
      setScopedModels(models: readonly ScopedModel[]) {
        scopedModels = models;
      },
      takeDiagnostics: () => diagnostics.splice(0),
      getQueue,
      canForkFrom: (entryId: string) => nativeIds.has(entryId),
      setSessionName,
      setModel,
      cycleModel,
      setThinking,
      setQueueMode(name: Queue, mode: QueueMode) {
        queueMode[name] = mode;
      },
      clearQueue() {
        const cleared = getQueue();
        queue.steer.length = 0;
        queue.followUp.length = 0;
        reportQueue();
        return cleared;
      },
      enqueue: enqueueUser,
      async bindExtensions(bindings: Parameters<AgentSession["bindExtensions"]>[0] = {}) {
        extensionBindings = bindings;
        await extensions.bind(bindings);
      },
      async reload(options?: Parameters<AgentSession["reload"]>[0]) {
        if (active || settling || sessionCompaction.isCompacting || sessionTree.isNavigating) {
          throw new Error("Wait for the current operation to finish before reloading.");
        }
        cacheWarmer.cancel();
        const previousFlagValues = extensions.runner.getFlagValues();
        const reloadToolNames = extensions.getSelectedToolNames();
        await extensions.dispose("reload");
        extensions = await loadExtensions(
          scope,
          { ...extensionOptions, reloadToolNames, startReason: "reload" },
          previousFlagValues,
        );
        refreshSelectedModel();
        await options?.beforeSessionStart?.();
        await extensions.bind(extensionBindings);
      },
      async waitForIdle() {
        await waitForAgent();
        await sessionCompaction.waitForIdle();
        await sessionTree.waitForIdle();
      },
      compact: sessionCompaction.compact,
      abortCompaction: sessionCompaction.abort,
      navigateTree: sessionTree.navigate,
      abortBranchSummary: sessionTree.abort,
      setAutoCompactionEnabled(enabled: boolean) {
        extensions.settings.setCompactionEnabled(enabled);
        compaction.autoEnabled = enabled;
      },
      setAutoRetryEnabled(enabled: boolean) {
        extensions.settings.setRetryEnabled(enabled);
      },
      setCacheWarmingMode(mode: CacheWarmingMode) {
        extensions.settings.setCacheWarmingMode(mode);
        cacheWarmer.onModeChanged();
      },
      abortRetry() {
        retryWait?.abort();
      },
      settle,
      fork,
      abort,
      abortBash,
      recordBashResult,
      async executeBash(command: string, onChunk?: (chunk: string) => void, options?: BashOptions) {
        if (sessionTree.isNavigating)
          throw new Error("Wait for the current tree navigation to finish.");
        const controller = new AbortController();
        const prefix = extensions.settings.getShellCommandPrefix();
        const run = (async () => {
          const { output, exitCode, cancelled, truncated, fullOutputPath } = await bash(
            prefix ? `${prefix}\n${command}` : command,
            {
              signal: controller.signal,
              shellPath: extensions.settings.getShellPath(),
              operations: options?.operations,
              reportOutput(delta) {
                onChunk?.(delta);
                events.emit({ type: "bash_execution_update", id: options?.id, delta });
              },
            },
          );
          const result = { output, exitCode, cancelled, truncated, fullOutputPath };
          recordBashResult(command, result, options);
          return result;
        })();
        runningBash.set(controller, run);
        try {
          return await run;
        } finally {
          runningBash.delete(controller);
        }
      },
      history,
      prompt,
      async dispose(
        reason?: SessionShutdownEvent["reason"],
        beforeInvalidate?: () => void,
      ): Promise<void> {
        closing = true;
        try {
          await settle();
          await extensions?.dispose(reason, beforeInvalidate);
          await extensions?.settings.flush();
          await sessionTree.save();
        } finally {
          scope.dispose();
        }
      },
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}

export type CliSession = Awaited<ReturnType<typeof createSession>>;
