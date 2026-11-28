import { StateSyncClientService } from "@harness/state-sync";
import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { RpcClientService } from "@harness/rpc";
import { StreamClientService } from "@harness/stream";
import { ChatRpcContract, ChatStateSyncContract, ChatStreamContract } from "./contract.ts";
import { ImageBlock, Message, TextBlock, UserMessage, type ContentBlock } from "@harness/llm";
import { UiSessionsService } from "@harness/ui-sessions";
import { CrossTabSync, LocalSync, UiStorageService } from "@harness/ui-storage";
import {
  computed,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  toRef,
  watch,
  type ComputedRef,
  type Ref,
  type ShallowRef,
  type WritableComputedRef,
} from "vue";
import { z } from "zod";
import { getMessageImages, LiveRun, toTranscript } from "./transcript.ts";
import {
  ChatTimestampField,
  TurnGroupField,
  type ChatMessagesPage,
  type ChatModel,
  type ChatPreset,
  type ChatRunOptions,
  type ChatRunState,
  type SessionMessage,
} from "./types.ts";
import { createChatMenu } from "./menus.ts";

export { TurnGroupField };
export type { ChatMenuContext } from "./menus.ts";
export { getPendingText } from "./transcript.ts";

export const getPendingImages = getMessageImages;

export function getPendingTurnGroup(msg: UserMessage): string {
  return msg.meta.get(TurnGroupField) ?? msg.id;
}

const DraftImageSchema = z.object({
  fileId: z.string().min(1),
  mimeType: z.string(),
  filename: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  detail: z.enum(["auto", "low", "high", "original"]).optional(),
});

const idleRun: ChatRunState = { runId: null, before: 0, notice: "" };

// Extensible lifecycle hooks registered in the consumer's EffectScope.
export interface UiChatHooks {
  readonly submitMessage: HookSlot<void>;
}

export class UiChatService {
  readonly menu = createChatMenu(this);
  readonly mode: Ref<string>;
  readonly model: WritableComputedRef<string>;
  readonly models: ComputedRef<readonly ChatModel[]>;
  readonly selectedModel: ComputedRef<ChatModel | undefined>;
  readonly preset: WritableComputedRef<string>;
  readonly presets: ComputedRef<readonly ChatPreset[]>;
  readonly selectedPreset: ComputedRef<ChatPreset | undefined>;
  readonly isPresetLocked: ComputedRef<boolean>;
  readonly messages: ComputedRef<SessionMessage[]>;
  readonly pendingInputs: ComputedRef<UserMessage[]>;
  readonly queuedInputs: ComputedRef<UserMessage[]>;
  readonly draft: WritableComputedRef<string>;
  readonly draftImages: WritableComputedRef<readonly ImageBlock[]>;
  readonly notice: ShallowRef<string> = shallowRef("");

  readonly hooks: UiChatHooks = {
    submitMessage: new HookSlot<void>(),
  };

  private readonly storage = inject(UiStorageService);
  private readonly sessions = inject(UiSessionsService);
  private readonly chatRpc = inject(RpcClientService).use(ChatRpcContract);
  private readonly chatStream = inject(StreamClientService).use(ChatStreamContract);
  private readonly chatStateSync = inject(StateSyncClientService).use(ChatStateSyncContract);
  private readonly modelList: ShallowRef<readonly ChatModel[]> = shallowRef([]);
  private readonly presetList: ShallowRef<readonly ChatPreset[]> = shallowRef([]);
  private readonly initialChoices: Promise<void>;
  private readonly history = shallowRef<readonly Message[]>([]);
  private readonly live = shallowRef<{ readonly run: LiveRun; readonly active: boolean }>();
  private readonly running = computed(() => Boolean(this.chatStateSync.status.value?.runId));
  private follower: AbortController | undefined;
  private readonly pageState = shallowReactive({
    nextBefore: null as number | null,
    hasMore: false,
    loadingOlder: false,
    initialized: false,
  });
  private readonly prefs = this.storage.use(
    "core:ui-chat:prefs",
    {
      model: z.string().default(""),
      preset: z.string().default(""),
      mode: z.string().default("Agent"),
    },
    new CrossTabSync(),
  );

  constructor(readonly sessionId: string) {
    this.mode = toRef(this.prefs, "mode");
    this.models = computed(() => this.modelList.value);
    this.selectedModel = computed(() => {
      const list = this.modelList.value;
      const savedId = this.session()?.modelId || this.prefs.model;
      return list.find((item) => item.id === savedId) ?? list[0];
    });
    this.model = computed({
      get: () => this.selectedModel.value?.id ?? "",
      set: (next: string) => {
        this.prefs.model = next;
        this.configure({ modelId: next });
      },
    });
    this.presets = computed(() => this.presetList.value);
    this.selectedPreset = computed(() => {
      const list = this.presetList.value;
      const savedId = this.session()?.presetId || this.prefs.preset;
      return list.find((item) => item.id === savedId) ?? list[0];
    });
    this.isPresetLocked = computed(
      () => this.history.value.length > 0 || this.live.value !== undefined || this.running.value,
    );
    this.preset = computed({
      get: () => this.selectedPreset.value?.id ?? "",
      set: (next: string) => {
        if (this.isPresetLocked.value) return;
        this.prefs.preset = next;
        this.configure({ presetId: next });
      },
    });
    this.messages = computed(() => {
      this.ensureLoaded();
      const live = this.live.value;
      return toTranscript(
        live ? [...this.history.value, ...live.run.messages] : this.history.value,
        live?.active ? live.run : undefined,
      );
    });
    this.pendingInputs = computed(() => this.chatStateSync.pending.items);
    this.queuedInputs = computed(() => this.chatStateSync.queue.items);
    this.draft = computed({
      get: () => this.sessionDraft().text,
      set: (next: string) => {
        this.sessionDraft().text = next;
      },
    });

    this.draftImages = computed({
      get: () => this.sessionDraft().images.map((image) => ImageBlock.create(image)),
      set: (images: readonly ImageBlock[]) => {
        this.sessionDraft().images = images.flatMap(
          ({ fileId, mimeType, filename, width, height, detail }) =>
            fileId ? [{ fileId, mimeType, filename, width, height, detail }] : [],
        );
      },
    });

    watch(
      () => this.chatStateSync.status.value?.notice,
      (notice) => {
        if (notice !== undefined) this.notice.value = notice;
      },
    );

    watch(
      () => this.pageState.initialized && (this.chatStateSync.status.value ?? idleRun),
      (status, previous) => {
        if (status && (!previous || status.runId !== previous.runId)) void this.follow(status);
      },
    );

    onScopeDispose(() => this.follower?.abort());

    this.initialChoices = this.refreshChoices();
  }

  private didSubmitMessage(): void {
    try {
      this.hooks.submitMessage.run(undefined);
    } catch (error) {
      console.error(error);
    }
  }

  isRunning(): boolean {
    return this.running.value;
  }

  acknowledgeStatus(): void {
    void this.chatRpc?.acknowledgeStatus().catch(() => {});
  }

  abort(): void {
    void this.chatRpc?.abortRun().catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      this.notice.value = error instanceof Error ? error.message : String(error);
    });
  }

  private resolveInputBlocks(content?: readonly ContentBlock[]): ContentBlock[] {
    const draftState = this.sessionDraft();
    const text = draftState.text.trim();
    const blocks: ContentBlock[] = [];
    const hasTextBlock =
      content?.some((block) => block instanceof TextBlock && block.text.trim().length > 0) ?? false;
    if (!hasTextBlock && text.length > 0) {
      blocks.push(TextBlock.create({ text }));
    }
    if (content) {
      for (const block of content) {
        if (block instanceof TextBlock && block.text.trim().length === 0) continue;
        blocks.push(block);
      }
    }
    if (!content?.some((block) => block instanceof ImageBlock)) {
      blocks.push(...this.draftImages.value);
    }
    return blocks;
  }

  async send(content?: readonly ContentBlock[]): Promise<void> {
    if (!this.hasSession()) return;

    const blocks = this.resolveInputBlocks(content);
    if (blocks.length === 0) {
      const { pending, queue } = this.chatStateSync;
      if (!this.running.value && (pending.items.length > 0 || queue.items.length > 0)) {
        await this.startRun();
      }
      return;
    }

    const userMessage = this.submit(blocks);
    if (this.running.value || this.chatStateSync.queue.items.length > 0) {
      this.chatStateSync.queue.items.push(userMessage);
      this.didSubmitMessage();
      return;
    }

    this.chatStateSync.pending.items.push(userMessage);
    this.didSubmitMessage();
    await this.startRun();
  }

  async steer(content?: readonly ContentBlock[]): Promise<void> {
    if (!this.hasSession()) return;

    const blocks = this.resolveInputBlocks(content);
    if (blocks.length > 0) {
      this.chatStateSync.pending.items.push(this.submit(blocks));
      this.didSubmitMessage();
      if (!this.running.value) await this.startRun();
      return;
    }

    if (this.chatStateSync.queue.items.length > 0) {
      await this.steerQueued(0);
    }
  }

  async steerQueued(index = 0): Promise<void> {
    const queueItems = this.chatStateSync.queue.items;
    if (index < 0 || index >= queueItems.length) return;

    const [steeredItem] = queueItems.splice(index, 1);
    if (!steeredItem) return;

    this.chatStateSync.pending.items.push(steeredItem);
    this.didSubmitMessage();

    if (!this.running.value) await this.startRun();
  }

  private session() {
    return this.sessions.sessions.value.find((item) => item.id === this.sessionId);
  }

  private configure(options: ChatRunOptions): void {
    void this.chatRpc.configure(options).catch((error: unknown) => {
      this.notice.value = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  private hasSession(): boolean {
    return this.sessions.sessions.value.some((item) => item.id === this.sessionId);
  }

  private submit(blocks: ContentBlock[]): UserMessage {
    const message = UserMessage.create({ content: blocks });
    message.meta.set(ChatTimestampField, Date.now());
    message.meta.set(TurnGroupField, crypto.randomUUID());
    this.clearDraft();
    return message;
  }

  private async startRun(): Promise<void> {
    if (!this.chatRpc) return;
    this.notice.value = "";
    if (this.selectedModel.value === undefined) await this.initialChoices;
    try {
      await this.chatRpc.start({
        modelId: this.selectedModel.value?.id,
        presetId: this.preset.value || undefined,
      });
    } catch (error) {
      this.notice.value = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async refreshChoices(): Promise<void> {
    if (this.chatRpc === undefined) return;
    try {
      this.modelList.value = await this.chatRpc.listModels();
    } catch {
      // Missing models are surfaced in the status bar.
    }
    try {
      this.presetList.value = [...(await this.chatRpc.listPresets())];
    } catch {
      // Missing presets fall back to server default.
    }
  }

  hasMoreMessages(): boolean {
    return this.pageState.hasMore;
  }

  async loadOlder(): Promise<number> {
    if (!this.chatRpc) return 0;
    const state = this.pageState;
    if (state.loadingOlder || !state.hasMore || state.nextBefore === null) return 0;
    state.loadingOlder = true;
    try {
      const page = await this.chatRpc.loadMessages({
        before: state.nextBefore,
        limit: 30,
      });
      state.nextBefore = page.nextBefore;
      state.hasMore = page.hasMore;
      const existing = new Set(this.history.value.map((item) => item.id));
      const prepended = deserialize(page).filter((item) => !existing.has(item.id));
      if (prepended.length > 0) {
        this.history.value = [...prepended, ...this.history.value];
      }
      return prepended.length;
    } finally {
      state.loadingOlder = false;
    }
  }

  private ensureLoaded(): void {
    if (!this.chatRpc || this.pageState.initialized) return;
    this.pageState.initialized = true;
  }

  // History before the run comes from the backend; the run itself is replayed from its first event.
  private async follow({ runId, before }: ChatRunState): Promise<void> {
    this.follower?.abort();
    const controller = new AbortController();
    this.follower = controller;
    const { signal } = controller;
    try {
      const page = await this.chatRpc.loadMessages(runId ? { before, limit: 30 } : { limit: 30 });
      if (signal.aborted) return;
      this.mergeLatest(page);
      if (!runId) {
        this.live.value = undefined;
        return;
      }
      const run = new LiveRun();
      this.live.value = { run, active: true };
      for await (const event of this.chatStream.attachStream(undefined, signal)) {
        run.apply(event);
        this.live.value = { run, active: true };
      }
      if (!signal.aborted) this.live.value = { run, active: false };
    } catch {
      // The next status change resynchronizes from the backend.
    }
  }

  private mergeLatest(page: ChatMessagesPage): void {
    const incoming = deserialize(page);
    const current = this.history.value;
    const start = incoming.length > 0 ? current.findIndex(({ id }) => id === incoming[0]!.id) : -1;
    if (start !== -1) {
      this.history.value = [...current.slice(0, start), ...incoming];
      return;
    }
    this.history.value = incoming;
    this.pageState.nextBefore = page.nextBefore;
    this.pageState.hasMore = page.hasMore;
  }

  private sessionDraft() {
    return this.storage
      .scope("session", this.sessionId)
      .use(
        "core:ui-chat:draft",
        { text: z.string().default(""), images: z.array(DraftImageSchema).default(() => []) },
        new LocalSync({ writeDelayMs: 250 }),
      );
  }

  private clearDraft(): void {
    const draft = this.sessionDraft();
    draft.text = "";
    draft.images = [];
  }
}

function deserialize(page: ChatMessagesPage): Message[] {
  return page.messages.flatMap((raw) => {
    try {
      return [Message.deserialize(raw)];
    } catch {
      return [];
    }
  });
}
