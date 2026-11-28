import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { UiStorageService } from "@harness/ui-storage";
import { ExtensibleFields } from "@harness/variants";
import { computed, shallowReactive, toRef, type ComputedRef, type Ref } from "vue";
import { z } from "zod";
import {
  SessionMeta,
  SessionsRpcContract,
  SessionsStateSyncContract,
  type SessionSummary,
  type SessionView,
} from "./types.ts";
import { createSessionMenu } from "./menus.ts";

export type { SessionMenuContext } from "./menus.ts";

export interface UiSessionsHooks {
  readonly remove: HookSlot<string, void>;
}

export class UiSessionsService {
  readonly menu = createSessionMenu();
  readonly activeId: Ref<string>;
  readonly sessions: ComputedRef<readonly SessionView[]>;
  readonly current: ComputedRef<SessionView | undefined>;
  readonly hooks: UiSessionsHooks = {
    remove: new HookSlot<string, void>(),
  };

  private readonly storage = inject(UiStorageService);
  private readonly sessionsSync = inject(StateSyncClientService).use(SessionsStateSyncContract);
  private readonly sessionsRpc = inject(RpcClientService).use(SessionsRpcContract);
  // Sessions created here whose catalog entry is still on its way back.
  private readonly creating = shallowReactive(new Map<string, Promise<void>>());
  private readonly local = this.storage.use("core:ui-sessions:local", {
    activeId: z.string().default(""),
  });
  private readonly metaCache = new Map<
    string,
    { readonly raw: SessionSummary["meta"]; readonly meta: SessionMeta }
  >();

  constructor() {
    this.activeId = toRef(this.local, "activeId");

    this.sessions = computed(() =>
      this.sessionsSync.items.items.map((summary) => ({
        id: summary.id,
        workspaceId: summary.workspaceId || "default",
        title: summary.title ?? "New conversation",
        createdAt: summary.createdAt,
        modelId: summary.modelId,
        presetId: summary.presetId,
        meta: this.resolveMeta(summary),
      })),
    );

    this.current = computed(() => {
      const active = this.sessions.value.find((item) => item.id === this.activeId.value);
      if (active || this.creating.has(this.activeId.value)) return active;
      return this.sessions.value[0];
    });
  }

  newSession(workspaceId?: string): string {
    const id = crypto.randomUUID();
    const created = this.sessionsRpc
      .create({ id, workspaceId: workspaceId ?? this.current.value?.workspaceId ?? "default" })
      .catch((error: unknown) => console.error(error))
      .finally(() => this.creating.delete(id));
    this.creating.set(id, created);
    this.local.activeId = id;
    return id;
  }

  renameSession(id: string, title: string): void {
    if (!title.trim()) return;
    void this.afterCreate(id, () => this.sessionsRpc.rename({ id, title }));
  }

  commitMeta(id: string): void {
    const meta = this.metaCache.get(id)?.meta;
    if (!meta) return;
    const serialized = ExtensibleFields.serialize(meta);
    void this.afterCreate(id, () => this.sessionsRpc.setMeta({ id, meta: serialized }));
  }

  removeSession(id: string): void {
    this.hooks.remove.run(id, () => {
      this.forget(id);
      if (this.local.activeId === id) this.local.activeId = this.remaining([id])[0]?.id ?? "";
    });
  }

  removeWorkspaceSessions(workspaceId: string): void {
    const ids = this.sessionsSync.items.items
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => item.id);
    for (const id of ids) {
      this.hooks.remove.run(id, () => this.forget(id));
    }
    const remaining = this.remaining(ids);
    if (!remaining.some((item) => item.id === this.local.activeId)) {
      this.local.activeId = remaining[0]?.id ?? "";
    }
  }

  private forget(id: string): void {
    this.metaCache.delete(id);
    this.storage.scope("session", id).clear();
    void this.afterCreate(id, () => this.sessionsRpc.remove({ id }));
  }

  private remaining(removed: readonly string[]): readonly SessionSummary[] {
    return this.sessionsSync.items.items.filter((item) => !removed.includes(item.id));
  }

  private async afterCreate(id: string, call: () => Promise<void>): Promise<void> {
    await this.creating.get(id);
    await call().catch((error: unknown) => console.error(error));
  }

  // Re-read whenever the synced meta changes, so edits from other clients and the backend show up.
  private resolveMeta(summary: SessionSummary): SessionMeta {
    const cached = this.metaCache.get(summary.id);
    if (cached !== undefined && cached.raw === summary.meta) return cached.meta;
    const meta = SessionMeta.deserialize(summary.meta);
    this.metaCache.set(summary.id, { raw: summary.meta, meta });
    return meta;
  }
}
