import { StateSyncClientService } from "@harness/state-sync";
import { createDescriptor, CurrentScope, inject, type Scope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { StreamClientService } from "@harness/stream";
import { Transport } from "@harness/transport";
import { type ChatModel, ChatRpcContract, UiChatService } from "@harness/ui-chat";
import { UiComposerHistoryService } from "@harness/ui-composer-history";
import { UiSessionsService } from "@harness/ui-sessions";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import {
  type ComputedRef,
  computed,
  onScopeDispose,
  type Ref,
  type ShallowRef,
  shallowReactive,
  shallowRef,
  toRef,
  watch,
  type WritableComputedRef,
} from "vue";
import { z } from "zod";

export class UiChatManagerService {
  readonly mode: Ref<string>;
  readonly model: WritableComputedRef<string>;
  readonly models: ComputedRef<readonly ChatModel[]>;
  readonly selectedModel: ComputedRef<ChatModel | undefined>;

  private readonly currentScope = inject(CurrentScope);
  private readonly sessions = inject(UiSessionsService);
  private readonly storage = inject(UiStorageService);
  private readonly transport = inject(Transport);
  private readonly chatRpc = inject(RpcClientService).use(ChatRpcContract);
  private readonly modelList: ShallowRef<readonly ChatModel[]> = shallowRef([]);
  private readonly agents = shallowReactive(new Map<string, Scope>());
  private readonly prefs = this.storage.use(
    "core:ui-chat:prefs",
    {
      model: z.string().default(""),
      mode: z.string().default("Agent"),
    },
    new CrossTabSync(),
  );

  constructor() {
    this.mode = toRef(this.prefs, "mode");
    this.models = computed(() => this.modelList.value);
    this.selectedModel = computed(() => {
      const list = this.modelList.value;
      return list.find((item) => item.id === this.prefs.model) ?? list[0];
    });
    this.model = computed({
      get: () => this.selectedModel.value?.id ?? "",
      set: (next: string) => {
        this.prefs.model = next;
      },
    });

    this.sessions.hooks.remove.use((id, next) => {
      this.dispose(id);
      next();
    });

    watch(this.sessions.activeId, (activeId) => {
      if (!activeId) return;
      this.get(activeId).acknowledgeStatus();
    });

    if (typeof document !== "undefined") {
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible" && this.sessions.activeId.value) {
          this.get(this.sessions.activeId.value).acknowledgeStatus();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      onScopeDispose(() => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      });
    }

    onScopeDispose(() => {
      for (const id of [...this.agents.keys()]) {
        this.dispose(id);
      }
    });

    void this.refreshModels();
  }

  get(sessionId: string): UiChatService {
    return this.agentScope(sessionId).get(UiChatService);
  }

  composerHistory(sessionId: string): UiComposerHistoryService {
    return this.agentScope(sessionId).get(UiComposerHistoryService);
  }

  link(scope: Scope, sessionId: string): UiChatService {
    const chat = this.get(sessionId);
    scope.provide(
      UiChatService,
      class extends UiChatService {
        constructor() {
          super(sessionId);
          return chat;
        }
      } as any,
    );
    return chat;
  }

  isRunning(sessionId?: string): boolean {
    if (sessionId !== undefined) {
      return this.agents.get(sessionId)?.get(UiChatService).isRunning() ?? false;
    }
    for (const scope of this.agents.values()) {
      if (scope.get(UiChatService).isRunning()) return true;
    }
    return false;
  }

  dispose(sessionId: string): void {
    const scope = this.agents.get(sessionId);
    if (scope === undefined) return;
    scope.dispose();
    this.agents.delete(sessionId);
  }

  private agentScope(sessionId: string): Scope {
    const existing = this.agents.get(sessionId);
    if (existing !== undefined) return existing;

    const scope = this.currentScope.createChild({ id: `chat:${sessionId}` });
    scope.provide(Transport, this.transport.childScope(sessionId));
    scope.provide(RpcClientService, createDescriptor(RpcClientService));
    scope.provide(StreamClientService, createDescriptor(StreamClientService));
    scope.provide(StateSyncClientService, createDescriptor(StateSyncClientService));
    scope.provide(UiChatService, createDescriptor(UiChatService, sessionId));
    scope.provide(UiComposerHistoryService, createDescriptor(UiComposerHistoryService));
    this.agents.set(sessionId, scope);
    return scope;
  }

  async refreshModels(): Promise<void> {
    if (this.chatRpc === undefined) return;
    try {
      this.modelList.value = await this.chatRpc.listModels();
    } catch {
      // Missing models are surfaced in the status bar.
    }
  }
}
