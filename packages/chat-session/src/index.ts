import { AgentLoop, SupplementaryField } from "@harness/agent-loop";
import { AgentsMdService } from "@harness/agents-md";
import { AgentPresetRegistry, type AgentPreset } from "@harness/agent-preset";
import { ChatRunService } from "@harness/chat-run";
import { Context } from "@harness/context";
import { ContextSizeService } from "@harness/context-size";
import { CwdService } from "@harness/cwd";
import {
  createDescriptor,
  inject,
  optionalInject,
  InstantiationService,
  useServices,
  type Scope,
} from "@harness/di";
import { ImageStorageService } from "@harness/image-storage";
import {
  DeveloperMessage,
  extractText,
  ImageBlock,
  LlmService,
  Message,
  MessageMeta,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type ContentBlock,
  type LlmModelInfo,
} from "@harness/llm";
import { ModelSelectionService } from "@harness/model-selection";
import { PiCompactionService } from "@harness/pi-compaction";
import { SessionDigestService } from "@harness/session-digest/node";
import { SessionCatalog } from "@harness/session-catalog";
import { SessionTitleService } from "@harness/session-title";
import { SessionManager } from "@harness/session-manager";
import { SessionStatusService } from "@harness/session-status/node";
import { SkillsService } from "@harness/skills";
import { SyncedArrayHost, SyncedValueHost } from "@harness/state-sync";
import { AgentManager } from "@harness/subagent";
import { ToolCallService } from "@harness/tool-call";
import { WorkspaceCatalog } from "@harness/workspace-catalog";
import {
  effectScope,
  pauseTracking,
  resetTracking,
  shallowRef,
  type ShallowRef,
} from "reactivity";
import { empty, single } from "./iterables.ts";
import {
  ChatDurationField,
  TurnGroupField,
  type ChatMessagesPage,
  type ChatRunOptions,
  type ChatRunState,
  type ChatStreamEvent,
} from "./types.ts";

interface RunOutcome {
  readonly proceed: boolean;
  readonly notice: string;
}

interface SessionAgent {
  readonly scope: Scope;
  readonly presetId: ShallowRef<string>;
}

// Provides the chat runtime in every session scope.
export function useChatSessions(): void {
  inject(SessionManager).useSessionSetup((sessionId) => {
    const catalog = inject(SessionCatalog);
    const workspaces = inject(WorkspaceCatalog);
    // Untracked, so editing the workspace does not rebuild the services of a live session.
    pauseTracking();
    let cwd: string | undefined;
    try {
      cwd = workspaces.resolve(catalog.get(sessionId)?.workspaceId)?.folders[0]?.trim();
    } finally {
      resetTracking();
    }
    useServices([
      createDescriptor(CwdService, cwd || undefined),
      // ChatSession selects the session's model.
      createDescriptor(ModelSelectionService, { provider: "deepseek", model: "" }),
      AgentManager,
      ChatRunService,
      createDescriptor(ChatSession, sessionId),
    ]);
  });
}

// The chat runtime of one session: its input queues, run state, runs and history.
export class ChatSession {
  readonly pending = new SyncedArrayHost<UserMessage>();
  readonly queue = new SyncedArrayHost<UserMessage>();
  readonly status = new SyncedValueHost<ChatRunState>({ runId: null, before: 0, notice: "" });
  private readonly catalog = inject(SessionCatalog);
  private readonly sessionTitle = optionalInject(SessionTitleService);
  private readonly workspaces = inject(WorkspaceCatalog);
  private readonly llm = inject(LlmService);
  private readonly presetRegistry = inject(AgentPresetRegistry);
  private readonly images = inject(ImageStorageService);
  private readonly instantiation = inject(InstantiationService);
  private readonly run = inject(ChatRunService<ChatStreamEvent>);
  private readonly agents = inject(AgentManager);
  private readonly selection = inject(ModelSelectionService);
  private agent: SessionAgent | undefined;
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.select(this.resolveModel(this.catalog.get(sessionId)?.modelId));
  }

  // The agent's context, or a reader of the persisted transcript before the first run.
  get context(): Context {
    return (
      this.agent?.scope.get(Context) ?? this.instantiation.createInstance(Context, { id: this.sessionId })
    );
  }

  async loadMessages(
    options?: { readonly before?: number; readonly limit?: number },
  ): Promise<ChatMessagesPage> {
    const limit = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const context = this.context;
    const chunks: Message[][] = [];
    let count = 0;
    let nextBefore: number | null = null;
    let hasMore = false;

    const visible = (message: Message) => message.meta.get(SupplementaryField) !== true;
    const pending = context.pending.filter(visible);
    if (options?.before === undefined && pending.length > 0) {
      chunks.push(pending);
      count += pending.length;
    }

    for await (const batch of context.readBackward()) {
      if (options?.before !== undefined && batch.index >= options.before) continue;
      if (count >= limit) {
        hasMore = true;
        break;
      }
      const messages = batch.messages.filter(visible);
      chunks.push(messages);
      count += messages.length;
      nextBefore = batch.index;
    }

    return {
      messages: chunks.reverse().flat().map((message) => Message.serialize(message)),
      nextBefore: hasMore ? nextBefore : null,
      hasMore,
    };
  }

  start(options?: ChatRunOptions): void {
    this.begin(options);
  }

  stream(options?: ChatRunOptions): AsyncIterable<ChatStreamEvent> {
    const error = this.begin(options);
    return error ? single({ type: "error", message: error }) : this.attach();
  }

  attach(signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    return this.run.subscribe(signal) ?? empty();
  }

  abort(): boolean {
    return this.run.abort();
  }

  acknowledgeStatus(): void {
    const status = this.agent?.scope.get(SessionStatusService);
    status?.set(status.current.value?.acknowledge());
  }

  // The model can change at any time; the preset only until the conversation starts.
  configure(options: ChatRunOptions): void {
    const locked = this.run.isRunning || this.context.batchCount > 0;
    this.catalog.configure(this.sessionId, {
      modelId: options.modelId,
      presetId: locked ? undefined : options.presetId,
    });
  }

  private begin(options: ChatRunOptions | undefined): string | undefined {
    this.configure(options ?? {});
    return this.run.isRunning ? undefined : this.startNext(options);
  }

  private startNext(override?: ChatRunOptions): string | undefined {
    const { pending, queue, status } = this;
    if (pending.items.length === 0) {
      const head = queue.items[0];
      if (!head) return undefined;
      let count = 1;
      while (count < queue.items.length && turnGroupOf(queue.items[count]!) === turnGroupOf(head)) {
        count++;
      }
      pending.items.push(...queue.items.splice(0, count));
    }

    const choice: ChatRunOptions = this.catalog.get(this.sessionId) ?? {};
    const model = this.resolveModel(override?.modelId ?? choice.modelId);
    const presetId = override?.presetId ?? choice.presetId ?? this.presetRegistry.defaultId;
    const preset = presetId !== undefined ? this.presetRegistry.presets.get(presetId) : undefined;
    if (!model || !preset) {
      const error = model ? `Unknown agent: ${presetId ?? "(none)"}` : "No model is available.";
      status.value = { ...status.value, notice: `Request failed: ${error}` };
      return error;
    }

    this.select(model);
    const agent = this.acquireAgent(preset);
    if (agent.presetId.value !== choice.presetId) {
      this.catalog.configure(this.sessionId, { presetId: agent.presetId.value });
    }
    status.value = {
      runId: crypto.randomUUID(),
      before: agent.scope.get(Context).batchCount,
      notice: "",
    };
    this.run.start(async (emit, signal) => {
      let outcome: RunOutcome = { proceed: false, notice: "" };
      try {
        outcome = await this.runAgent(agent.scope, emit, signal);
      } finally {
        status.value = { ...status.value, runId: null, notice: outcome.notice };
      }
      if (outcome.proceed) this.startNext();
    });
    return undefined;
  }

  private select(model: LlmModelInfo | undefined): void {
    if (model && !this.run.isRunning) {
      this.selection.select({ provider: model.provider, model: model.id });
    }
  }

  private resolveModel(modelId: string | undefined): LlmModelInfo | undefined {
    const models = this.llm.models;
    return models.find((item) => item.id === modelId) ?? models[0];
  }

  private acquireAgent(preset: AgentPreset): SessionAgent {
    if (!this.agent) {
      const scope = this.agents.create();
      scope.provideAll([
        createDescriptor(Context, { id: this.sessionId }),
        createDescriptor(SessionDigestService, { id: this.sessionId }),
        SessionStatusService,
        ContextSizeService,
        PiCompactionService,
        AgentsMdService,
        SkillsService,
        ToolCallService,
        AgentLoop,
      ]);
      const presetId = shallowRef(preset.id);
      const workspacePrompt = this.workspacePrompt();
      scope.setup(() => {
        // Read from the registry so a re-registered preset (e.g. after a hot update) takes over.
        this.presetRegistry.presets.get(presetId.value)?.setup();
        if (workspacePrompt) seedWorkspacePrompt(inject(Context), workspacePrompt);
      });
      this.agent = { scope, presetId };
    }
    const agent = this.agent;
    if (agent.scope.get(Context).batchCount === 0 && agent.presetId.value !== preset.id) {
      agent.presetId.value = preset.id;
    }
    return agent;
  }

  private workspacePrompt(): string | undefined {
    const workspace = this.workspaces.resolve(this.catalog.get(this.sessionId)?.workspaceId);
    const parts: string[] = [];
    const extraFolders = workspace?.folders.slice(1).filter((f) => f.trim().length > 0) ?? [];
    if (extraFolders.length > 0) {
      parts.push(`Additional workspace folders:\n${extraFolders.map((f) => `- ${f}`).join("\n")}`);
    }
    if (workspace?.instructions.trim()) {
      parts.push(`Workspace instructions:\n${workspace.instructions.trim()}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private async runAgent(
    agentScope: Scope,
    emit: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const context = agentScope.get(Context);
    const loop = agentScope.get(AgentLoop);
    const { pending } = this;
    const consumed: UserMessage[] = [];
    let produced = false;
    let failure: string | undefined;

    const publish = (message: Message) =>
      emit({ type: "message", message: Message.serialize(message) });
    const take = (messages: UserMessage[]) => {
      consumed.push(...messages);
      messages.forEach(publish);
      const first = messages[0];
      if (first && this.catalog.get(this.sessionId)?.title === undefined) {
        if (this.sessionTitle) {
          this.sessionTitle.generateTitle(this.sessionId, first.content, { signal });
        } else {
          const title = extractText(first.content).slice(0, 42) || "Review attachments";
          this.catalog.rename(this.sessionId, title);
        }
      }
    };

    const initial = pending.items.splice(0);
    take(initial);
    for (const message of initial) {
      context.pending.push(await this.loadImages(message));
    }

    const hooks = effectScope();
    let stepStartedAt = Date.now();
    hooks.run(() => {
      loop.hooks.transformContext.use(async (_input, next) => {
        const payload = await next();
        stepStartedAt = Date.now();
        return payload;
      });
      agentScope.get(ToolCallService).hooks.streamOutput.use(({ callId, delta }, next) => {
        emit({ type: "tool_output", id: callId, delta });
        return next();
      });
      // shouldSend is synchronous, so steered messages skip image loading.
      loop.hooks.shouldSend.use((_input, next) => {
        const messages = pending.items.splice(0);
        take(messages);
        context.pending.push(...messages);
        return next();
      });
      loop.hooks.streamChunk.use((chunk, next) => {
        if (chunk.type !== "finish") {
          if (chunk.type === "tool_call_start") produced = true;
          if (chunk.type === "text_delta" && chunk.delta.trim().length > 0) produced = true;
          emit({ type: "chunk", chunk });
        }
        return next();
      });
      loop.hooks.handleOutput.use(async ({ response }, next) => {
        await next();
        response.message.meta.set(ChatDurationField, Date.now() - stepStartedAt);
        publish(response.message);
        const callIds = new Set(
          response.message.content
            .filter((block): block is ToolCallBlock => block instanceof ToolCallBlock)
            .map((block) => block.id),
        );
        for (const message of context.pending) {
          if (message instanceof ToolResultMessage && callIds.has(message.toolCallId)) {
            publish(message);
          }
        }
      });
    });

    const onAbort = () => loop.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let thrown = false;
    try {
      if (!signal.aborted && (await loop.run()) === "max_tokens") {
        failure = "Model stopped after reaching max_tokens.";
      }
    } catch (error) {
      thrown = true;
      if (!signal.aborted) failure = error instanceof Error ? error.message : String(error);
    } finally {
      signal.removeEventListener("abort", onAbort);
      hooks.stop();
    }
    if (failure !== undefined) emit({ type: "error", message: failure });

    if ((signal.aborted || failure !== undefined) && !produced) {
      const ids = new Set(consumed.map(({ id }) => id));
      const kept = context.pending.filter(({ id }) => !ids.has(id));
      context.pending.splice(0, context.pending.length, ...kept);
      pending.items.unshift(...consumed);
      return {
        proceed: false,
        notice:
          failure !== undefined
            ? `Request failed: ${failure} — message returned to queue.`
            : "Stopped before response — message returned to queue.",
      };
    }
    if (!thrown && context.pending.length > 0) context.batch();
    return {
      proceed: !signal.aborted && failure === undefined,
      notice: failure !== undefined ? `Request failed: ${failure}` : "",
    };
  }

  private async loadImages(message: UserMessage): Promise<UserMessage> {
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      const id = block instanceof ImageBlock && !block.data ? block.fileId : undefined;
      const loaded = id ? await this.images.readBase64(id) : null;
      if (!loaded || !(block instanceof ImageBlock)) {
        content.push(block);
        continue;
      }
      content.push(
        ImageBlock.create({
          mimeType: loaded.mimeType,
          data: loaded.data,
          url: block.url,
          fileId: block.fileId,
          filename: block.filename,
          width: block.width,
          height: block.height,
          detail: block.detail,
        }),
      );
    }
    return UserMessage.create({ id: message.id, meta: message.meta, content });
  }
}

function turnGroupOf(message: UserMessage): string {
  return message.meta.get(TurnGroupField) ?? message.id;
}

function seedWorkspacePrompt(context: Context, prompt: string): void {
  if (context.batchCount > 0) return;
  const seeded = context.pending.some(
    (message) => message instanceof DeveloperMessage && extractText(message.content) === prompt,
  );
  if (seeded) return;
  context.pending.push(
    DeveloperMessage.create({
      content: [TextBlock.create({ text: prompt })],
      meta: new MessageMeta().set(SupplementaryField, true),
    }),
  );
}
