import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AgentSession,
  hasTrustRequiringProjectResources,
  initTheme,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
  SettingsManager,
  type AgentSessionRuntime,
  type PromptOptions,
  type ProjectTrustContext,
  type TuiMode,
} from "@earendil-works/pi-coding-agent";
import { SqliteService } from "@harness/sqlite";
import { fromPiContent } from "./extension-content.ts";
import { printModelList } from "./model-selection.ts";
import { createProjectTrustResolver } from "./project-trust.ts";
import { createSessionCatalog } from "./session-catalog.ts";
import { exportHtml, exportJsonl } from "./session-export.ts";
import {
  bindImportErrors,
  isSessionFile,
  loadPiSession,
  SessionImportError,
  type ImportedSession,
} from "./session-import.ts";
import { bindSessionPicker, pickSession } from "./session-picker.ts";
import {
  availableThinkingLevels,
  createSession,
  createSessionRoot,
  NoModelsAvailableError,
  type CliSession,
  type SessionOptions,
} from "./session.ts";

type PiModel = NonNullable<AgentSession["model"]>;
type Images = NonNullable<PromptOptions["images"]>;
type CwdChoice = "continue" | "fork";
type SelectCwd = (
  title: string,
  choices: Array<{ label: string; value: CwdChoice | undefined }>,
) => Promise<CwdChoice | undefined>;

interface SessionCwdIssue {
  readonly sessionCwd: string;
  readonly fallbackCwd: string;
  readonly sessionFile?: string;
}

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");

async function resolveSessionCwd(
  issue: SessionCwdIssue,
  select?: SelectCwd,
  cwdOverride?: string,
): Promise<{ cwd: string; storedCwd?: string; fork?: true } | undefined> {
  const cwd = cwdOverride ?? issue.sessionCwd;
  if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return { cwd, storedCwd: cwd !== issue.sessionCwd ? issue.sessionCwd : undefined };
  }
  const { MissingSessionCwdError, formatMissingSessionCwdPrompt, getMissingSessionCwdOptions } =
    (await import(new URL("core/session-cwd.js", sdk).href)) as {
      MissingSessionCwdError: new (issue: SessionCwdIssue) => Error;
      formatMissingSessionCwdPrompt: (issue: SessionCwdIssue) => string;
      getMissingSessionCwdOptions: (
        issue: SessionCwdIssue,
      ) => Array<{ label: string; value: CwdChoice | undefined }>;
    };
  if (!select || cwdOverride !== undefined)
    throw new MissingSessionCwdError({ ...issue, sessionCwd: cwd });
  const choice = await select(
    formatMissingSessionCwdPrompt(issue),
    getMissingSessionCwdOptions(issue),
  );
  if (choice === "continue") return { cwd: issue.fallbackCwd, storedCwd: issue.sessionCwd };
  if (choice === "fork") return { cwd: issue.fallbackCwd, fork: true };
  return undefined;
}

export interface LaunchPrompts {
  readonly initialMessage?: string;
  readonly initialImages?: Images;
  readonly messages: string[];
  readonly tuiMode?: TuiMode;
  readonly theme?: string;
  readonly verbose?: boolean;
}

// Pi's interactive mode derives its resume hint from the SessionManager it renders,
// but appends through it must keep reaching the real instance. Only the persistence
// getters are overridden, so the session database is never treated as a JSONL file.
function persistedSessionManager(
  transcript: CliSession["transcript"],
  sessionFile: string,
  defaultSessionDir: string,
): CliSession["transcript"] {
  const sessionDir = dirname(sessionFile);
  return new Proxy(transcript, {
    get(target, property) {
      if (property === "isPersisted") return () => true;
      if (property === "getSessionFile") return () => sessionFile;
      if (property === "getSessionDir") return () => sessionDir;
      if (property === "usesDefaultSessionDir") return () => sessionDir === defaultSessionDir;
      return Reflect.get(target, property, target);
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

function createSessionView(session: CliSession, options: SessionOptions) {
  const sessionFile = session.sessionFile;
  const transcript = session.transcript;
  const sessionManager =
    sessionFile === undefined
      ? transcript
      : persistedSessionManager(transcript, sessionFile, resolve(options.extensions.agentDir, "sessions"));
  const { settings } = session.extensions;
  const messages = () => sessionManager.buildSessionContext().messages;
  const getThinking = () => session.thinkingLevel;
  const availableThinking = () => availableThinkingLevels(session.model);
  function getSessionStats() {
    return AgentSession.prototype.getSessionStats.call({
      sessionManager,
      sessionId: session.id,
      sessionFile,
      getContextUsage: session.getContextUsage,
    });
  }
  async function enqueue(name: "steer" | "followUp", text: string, images?: Images) {
    return session.enqueue(name, text, fromPiContent(images ?? []));
  }

  return {
    sessionManager,
    settingsManager: settings,
    agent: {
      get signal() {
        return session.signal;
      },
      subscribe: (listener: () => Promise<void>) => session.events.subscribeBackpressure(listener),
    },
    subscribe: (listener: Parameters<AgentSession["subscribe"]>[0]) =>
      session.events.subscribe(listener),
    bindExtensions: session.bindExtensions,
    get model() {
      return session.toPiModel(session.model);
    },
    get modelRuntime() {
      return session.extensions.modelRuntime;
    },
    get state() {
      return {
        messages: messages(),
        model: session.toPiModel(session.model),
        thinkingLevel: getThinking(),
        systemPrompt: session.extensions.systemPrompt,
        tools: session.extensions.getCallableTools().map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      };
    },
    get messages() {
      return messages();
    },
    get sessionId() {
      return session.id;
    },
    get sessionFile() {
      return sessionFile;
    },
    get sessionName() {
      return sessionManager.getSessionName();
    },
    get thinkingLevel() {
      return getThinking();
    },
    get isStreaming() {
      return session.isRunning;
    },
    get isIdle() {
      return !session.isRunning && !session.isCompacting;
    },
    get isCompacting() {
      return session.isCompacting;
    },
    get isBashRunning() {
      return session.isBashRunning;
    },
    get autoCompactionEnabled() {
      return session.autoCompactionEnabled;
    },
    get cacheWarmingStatus() {
      return session.cacheWarmingStatus;
    },
    get autoRetryEnabled() {
      return session.extensions.settings.getRetryEnabled();
    },
    get isRetrying() {
      return session.isRetrying;
    },
    get retryAttempt() {
      return session.retryAttempt;
    },
    get steeringMode() {
      return session.queueMode.steer;
    },
    get followUpMode() {
      return session.queueMode.followUp;
    },
    get pendingMessageCount() {
      return session.pendingMessageCount;
    },
    get extensionRunner() {
      return session.extensions.runner;
    },
    get resourceLoader() {
      return session.extensions.resources;
    },
    get promptTemplates() {
      return session.extensions.resources.getPrompts().prompts;
    },
    get systemPrompt() {
      return session.extensions.systemPrompt;
    },
    getSteeringMessages: () => session.getQueue().steering,
    getFollowUpMessages: () => session.getQueue().followUp,
    getToolDefinition: (name: string) => session.extensions.runner.getToolDefinition(name),
    getContextUsage: session.getContextUsage,
    get scopedModels() {
      return session.scopedModels;
    },
    async prompt(text: string, options: PromptOptions = {}) {
      if (session.isRunning && options.streamingBehavior) {
        const disposition = await enqueue(options.streamingBehavior, text, options.images);
        options.preflightResult?.(disposition);
        return;
      }
      await session.prompt(
        text,
        fromPiContent(options.images ?? []),
        undefined,
        options.preflightResult,
      );
    },
    steer: (text: string, images?: Images) => enqueue("steer", text, images),
    followUp: (text: string, images?: Images) => enqueue("followUp", text, images),
    clearQueue: session.clearQueue,
    setSteeringMode: (mode: AgentSession["steeringMode"]) => session.setQueueMode("steer", mode),
    setFollowUpMode: (mode: AgentSession["followUpMode"]) => session.setQueueMode("followUp", mode),
    async abort() {
      session.abort();
      session.abortCompaction();
      session.abortBranchSummary();
      await session.waitForIdle();
    },
    waitForIdle: session.waitForIdle,
    setModel(model: PiModel, options?: Parameters<AgentSession["setModel"]>[1]) {
      return session.setModel(model.provider, model.id, options);
    },
    cycleModel: session.cycleModel,
    setThinkingLevel: session.setThinking,
    getAvailableThinkingLevels: availableThinking,
    cycleThinkingLevel(options?: Parameters<AgentSession["cycleThinkingLevel"]>[0]) {
      const levels = availableThinking();
      if (levels.length < 2) return null;
      const level = levels[(levels.indexOf(getThinking()) + 1) % levels.length]!;
      session.setThinking(level, options);
      return level;
    },
    getLastAssistantText() {
      for (const message of [...messages()].reverse()) {
        if (message.role !== "assistant") continue;
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (message.stopReason === "stop" || text.trim()) return text;
      }
      return undefined;
    },
    getSessionStats,
    getUserMessagesForForking() {
      return sessionManager.getBranch().flatMap((entry) => {
        if (
          entry.type !== "message" ||
          entry.message.role !== "user" ||
          !session.canForkFrom(entry.id)
        )
          return [];
        const content = entry.message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        return [{ entryId: entry.id, text }];
      });
    },
    setSessionName: session.setSessionName,
    compact: session.compact,
    setAutoCompactionEnabled: session.setAutoCompactionEnabled,
    setAutoRetryEnabled: session.setAutoRetryEnabled,
    abortRetry: session.abortRetry,
    abortCompaction: session.abortCompaction,
    abortBranchSummary: session.abortBranchSummary,
    executeBash: session.executeBash,
    recordBashResult: session.recordBashResult,
    abortBash: session.abortBash,
    exportToHtml: (path?: string, options?: { themeName?: string }) =>
      exportHtml(session, path, options),
    exportToJsonl: (path?: string) => exportJsonl(session, path),
    reload: session.reload,
    navigateTree: session.navigateTree,
    setCacheWarmingMode: session.setCacheWarmingMode,
    setScopedModels: session.setScopedModels,
  };
}

export async function runPiMode(
  options: SessionOptions,
  mode: "tui" | "text" | "json" | "rpc",
  { initialMessage, initialImages, messages, tuiMode, theme, verbose }: LaunchPrompts,
  listModels?: string,
): Promise<number> {
  const root = await createSessionRoot(options);
  const sqlite = root.get(SqliteService);
  const catalog = createSessionCatalog(root, options.database);
  const trust = createProjectTrustResolver(
    options.extensions.agentDir,
    options.extensions.mode,
    options.extensions.trustOverride,
  );

  async function closeRoot(): Promise<void> {
    root.dispose();
    await sqlite.close();
  }
  const selectStartupCwd: SelectCwd = async (title, choices) => {
    const settings = SettingsManager.create(options.cwd, options.extensions.agentDir, {
      projectTrusted: false,
    });
    const { showStartupSelector } = (await import(new URL("cli/startup-ui.js", sdk).href)) as {
      showStartupSelector: (
        settings: SettingsManager,
        ...args: Parameters<SelectCwd>
      ) => ReturnType<SelectCwd>;
    };
    return showStartupSelector(settings, title, choices);
  };

  let session: CliSession;
  try {
    let opening = options;
    if (listModels === undefined && options.forkReference !== undefined) {
      opening = { ...options, startReason: "fork" };
    } else {
      const reference =
        listModels !== undefined
          ? undefined
          : options.pickSession
            ? await pickSession(catalog, options.cwd, options.extensions.agentDir)
            : options.sessionReference;
      if (listModels === undefined && options.pickSession && reference === undefined) {
        console.log("No session selected");
        await closeRoot();
        return 0;
      }
      const path =
        !options.pickSession &&
        reference &&
        !catalog.owns(reference) &&
        isSessionFile(reference, options.cwd)
          ? reference
          : undefined;
      const imported = path ? await loadPiSession(path, options.cwd) : undefined;
      const selected =
        !imported && reference !== undefined ? catalog.resolve(reference, options.cwd) : undefined;
      const targetCwd = imported?.cwd ?? selected?.cwd;
      const location =
        targetCwd === undefined
          ? { cwd: options.cwd }
          : await resolveSessionCwd(
              {
                sessionCwd: targetCwd,
                fallbackCwd: options.cwd,
                sessionFile: imported?.path,
              },
              mode === "tui" ? selectStartupCwd : undefined,
            );
      if (!location) {
        await closeRoot();
        return 0;
      }
      opening = {
        ...options,
        cwd: location.cwd,
        storedCwd: location.storedCwd,
        sessionId: location.fork ? options.sessionId : (selected?.id ?? options.sessionId),
        forkReference: location.fork ? (imported?.path ?? selected?.id) : undefined,
        imported: location.fork ? undefined : imported,
        startReason: location.fork ? "fork" : options.startReason,
        continueRecent: !reference && options.continueRecent,
        ...(listModels === undefined
          ? {}
          : { provider: undefined, model: undefined, modelPatterns: [], apiKey: undefined }),
      };
    }
    session = await createSession(root, catalog, opening, trust);
  } catch (error) {
    await closeRoot();
    if (listModels !== undefined && error instanceof NoModelsAvailableError) {
      printModelList([], listModels);
      return 0;
    }
    throw error;
  }
  if (listModels !== undefined) {
    try {
      const runtime = session.extensions.modelRuntime;
      const error = runtime.getError();
      if (error) console.error(`Warning: errors loading models.json:\n${error}`);
      printModelList(runtime.getAvailableSnapshot(), listModels);
      return 0;
    } finally {
      await session.dispose().finally(closeRoot);
    }
  }
  let sessionView = createSessionView(session, options);
  let rebind: (() => Promise<void>) | undefined;
  let beforeInvalidate: (() => void) | undefined;
  let selectSessionCwd: SelectCwd | undefined;
  let replacing = false;
  let disposal: Promise<void> | undefined;

  async function replace(
    reason: "new" | "resume" | "fork",
    entry?: { readonly id: string; readonly position: "before" | "at" },
    request: {
      readonly sessionId?: string;
      readonly parentSession?: string;
      readonly cwd?: string;
      readonly storedCwd?: string;
      readonly forkReference?: string;
      readonly imported?: ImportedSession;
      readonly projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
    } = {},
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    if (replacing) throw new Error("A session replacement is already in progress");
    replacing = true;
    try {
      const runner = session.extensions.runner;
      const before = entry
        ? await runner.emit({
            type: "session_before_fork",
            entryId: entry.id,
            position: entry.position,
          })
        : await runner.emit({
            type: "session_before_switch",
            reason: reason === "new" ? "new" : "resume",
            targetSessionFile: request.imported?.path,
          });
      if (before?.cancel) return { cancelled: true };
      if (request.sessionId === session.id) return { cancelled: false };

      await session.settle();
      await session.extensions.settings.flush();
      const forked = entry ? await session.fork(entry.id, entry.position) : undefined;
      const cwd = request.cwd ?? session.cwd;
      // A resumed or externally forked session restores its stored selection; the live
      // model and thinking level carry over otherwise.
      const keepSelection = reason !== "resume" && request.forkReference === undefined;
      const next = await createSession(
        root,
        catalog,
        {
          ...options,
          cwd,
          storedCwd: request.storedCwd,
          sessionId: forked?.id ?? request.sessionId,
          forkReference: request.forkReference,
          name: forked?.name,
          parentSession: forked ? session.id : request.parentSession,
          continueRecent: false,
          startReason: reason,
          provider: undefined,
          model: undefined,
          thinking: undefined,
          retainSelection: keepSelection
            ? {
                provider: session.model.provider,
                model: session.model.id,
                thinking: session.thinkingLevel,
              }
            : undefined,
          imported: request.imported,
        },
        trust,
        request.projectTrustContextFactory?.(cwd),
      );
      try {
        await session.dispose(reason, beforeInvalidate);
      } catch (error) {
        await next.dispose();
        throw error;
      }
      session = next;
      sessionView = createSessionView(session, options);
      await rebind?.();
      return { cancelled: false, selectedText: forked?.selectedText };
    } finally {
      replacing = false;
    }
  }

  function dispose(): Promise<void> {
    return (disposal ??= session.dispose().finally(closeRoot));
  }

  async function openSession(
    source: { readonly id?: string; readonly cwd: string; readonly imported?: ImportedSession },
    cwdOverride?: string,
    projectTrustContextFactory?: (cwd: string) => ProjectTrustContext,
  ) {
    const location = await resolveSessionCwd(
      {
        sessionCwd: source.cwd,
        fallbackCwd: session.cwd,
        sessionFile: source.imported?.path,
      },
      selectSessionCwd,
      cwdOverride,
    );
    if (!location) return { cancelled: true };
    if (location.fork) {
      return replace("fork", undefined, {
        cwd: location.cwd,
        forkReference: source.imported?.path ?? source.id,
        projectTrustContextFactory,
      });
    }
    return replace("resume", undefined, {
      sessionId: source.id,
      cwd: location.cwd,
      storedCwd: location.storedCwd,
      imported: source.imported,
      projectTrustContextFactory,
    });
  }

  async function importFromJsonl(
    path: string,
    cwdOverride?: string,
    projectTrustContextFactory?: (cwd: string) => ProjectTrustContext,
  ) {
    let imported: ImportedSession;
    try {
      imported = await loadPiSession(path, session.cwd);
    } catch (error) {
      throw new SessionImportError(error instanceof Error ? error.message : String(error));
    }
    return openSession({ cwd: imported.cwd, imported }, cwdOverride, projectTrustContextFactory);
  }

  // Pi's modes accept a concrete runtime. This view supplies their host contract
  // while Context and AgentLoop remain the session and execution authorities.
  const runtime = {
    get session() {
      return sessionView;
    },
    get services() {
      return { cwd: session.cwd, agentDir: options.extensions.agentDir };
    },
    setBeforeSessionInvalidate(callback: () => void) {
      beforeInvalidate = callback;
    },
    setRebindSession(callback: () => Promise<void>) {
      rebind = callback;
    },
    takeUnreportedDiagnostics: () => session.takeDiagnostics(),
    dispose,
    newSession: async (request?: { parentSession?: string }) => replace("new", undefined, request),
    async switchSession(
      reference: string,
      request?: Parameters<AgentSessionRuntime["switchSession"]>[1],
    ) {
      await sqlite.flush();
      if (!catalog.owns(reference) && isSessionFile(reference, session.cwd)) {
        return importFromJsonl(
          reference,
          request?.cwdOverride,
          request?.projectTrustContextFactory,
        );
      }
      const selected = catalog.resolve(reference, session.cwd);
      return openSession(selected, request?.cwdOverride, request?.projectTrustContextFactory);
    },
    fork: (id: string, options?: { position?: "before" | "at" }) =>
      replace("fork", { id, position: options?.position ?? "before" }),
    importFromJsonl,
  };
  const bridge = runtime as unknown as AgentSessionRuntime;
  try {
    if (mode === "rpc") return await runRpcMode(bridge);
    if (mode === "tui") {
      initTheme(sessionView.settingsManager.getTheme());
      const autoTrustOnReloadCwd =
        options.extensions.trustOverride === undefined &&
        !hasTrustRequiringProjectResources(session.cwd)
          ? session.cwd
          : undefined;
      const interactive = new InteractiveMode(bridge, {
        initialMessage,
        initialImages,
        initialMessages: messages,
        initialThemeSetting: theme,
        startupDiagnostics: session.takeDiagnostics(),
        tuiMode,
        verbose,
        autoTrustOnReloadCwd,
      });
      const trustHost = interactive as unknown as {
        createProjectTrustContext(cwd: string): ProjectTrustContext;
        showExtensionSelector(title: string, choices: string[]): Promise<string | undefined>;
      };
      selectSessionCwd = async (title, choices) => {
        const label = await trustHost.showExtensionSelector(
          title,
          choices.map((option) => option.label),
        );
        return choices.find((option) => option.label === label)?.value;
      };
      bindImportErrors(interactive);
      bindSessionPicker(interactive, catalog, {
        current: () => session,
        select: (id) =>
          runtime.switchSession(id, {
            projectTrustContextFactory: (cwd) => trustHost.createProjectTrustContext(cwd),
          }),
        async rename(id, name) {
          if (id === session.id) {
            session.setSessionName(name);
            await sqlite.flush();
          } else {
            await catalog.rename(id, name);
          }
        },
      });
      try {
        await interactive.run();
        return 0;
      } finally {
        interactive.stop();
      }
    }
    return await runPrintMode(bridge, { mode, messages, initialMessage, initialImages });
  } finally {
    await dispose();
  }
}
