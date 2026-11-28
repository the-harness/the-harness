import { inject, onScopeDispose } from "@harness/di";
import { SqliteService } from "@harness/sqlite";
import { StateSyncServerService, SyncedRecordHost } from "@harness/state-sync/node";
import { computed, shallowReactive, type ComputedRef } from "reactivity";
import {
  InteractionRequest,
  InteractionStateSyncContract,
  type InteractionEntry,
  type InteractionResult,
} from "./variants.ts";

export * from "./variants.ts";

interface Deferred<T> {
  resolve: (value: InteractionResult<T>) => void;
}

export class InteractionHostService {
  private readonly sqlite = inject(SqliteService);
  readonly active = new SyncedRecordHost<readonly InteractionEntry[]>();

  private readonly pendingById = new Map<string, InteractionEntry>();
  private readonly deferredById = new Map<string, Deferred<any>>();

  constructor() {
    this.sqlite.write((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_interactions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  register(entry: InteractionEntry, deferred?: Deferred<any>): void {
    this.pendingById.set(entry.id, entry);
    if (deferred) this.deferredById.set(entry.id, deferred);

    this.sqlite.write((db) => {
      db.prepare(
        `INSERT OR REPLACE INTO session_interactions (id, session_id, data_json, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      ).run(
        entry.id,
        entry.sessionId,
        JSON.stringify(InteractionRequest.schema.encode(entry.request)),
        entry.createdAt,
      );
    });

    this.syncSession(entry.sessionId);
  }

  resolve(id: string, result: InteractionResult): boolean {
    const entry = this.pendingById.get(id);
    if (!entry) return false;

    this.pendingById.delete(id);
    const deferred = this.deferredById.get(id);
    this.deferredById.delete(id);

    this.sqlite.write((db) => {
      db.prepare(
        `UPDATE session_interactions SET status = ?, result_json = ? WHERE id = ? AND status = 'pending'`,
      ).run(result.status, JSON.stringify(result), id);
    });

    this.syncSession(entry.sessionId);
    deferred?.resolve(result);
    return true;
  }

  recoverFromSqlite(): void {
    const rows = this.sqlite.read((db) =>
      db
        .prepare(
          `SELECT id, session_id, data_json, created_at FROM session_interactions WHERE status = 'pending' ORDER BY created_at ASC`,
        )
        .all() as Array<{
          id: string;
          session_id: string;
          data_json: string;
          created_at: number;
        }>,
    );

    const sessions = new Set<string>();
    for (const row of rows) {
      const parsed = InteractionRequest.schema.safeParse(JSON.parse(row.data_json));
      if (!parsed.success) continue;
      this.pendingById.set(row.id, {
        id: row.id,
        sessionId: row.session_id,
        request: parsed.data,
        createdAt: row.created_at,
      });
      sessions.add(row.session_id);
    }
    for (const sessionId of sessions) {
      this.syncSession(sessionId);
    }
  }

  private syncSession(sessionId: string): void {
    const list: InteractionEntry[] = [];
    for (const entry of this.pendingById.values()) {
      if (entry.sessionId === sessionId) list.push(entry);
    }
    if (list.length > 0) {
      this.active.items.set(sessionId, list);
    } else {
      this.active.items.delete(sessionId);
    }
  }
}

export class SessionInteractionService {
  private readonly host = inject(InteractionHostService);
  private readonly localPending = shallowReactive(new Map<string, InteractionEntry>());

  readonly pending: ComputedRef<readonly InteractionEntry[]> = computed(() => [
    ...this.localPending.values(),
  ]);

  constructor(private readonly sessionId: string) {
    onScopeDispose(() => {
      for (const id of this.localPending.keys()) {
        this.host.resolve(id, { status: "cancelled", reason: "Session disposed" });
      }
      this.localPending.clear();
    });
  }

  request<TRes = unknown>(
    req: InteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionResult<TRes>> {
    const id = `${this.sessionId}:${crypto.randomUUID()}`;
    const entry: InteractionEntry = {
      id,
      sessionId: this.sessionId,
      request: req,
      createdAt: Date.now(),
    };

    return new Promise<InteractionResult<TRes>>((resolve) => {
      const cleanup = () => {
        this.localPending.delete(id);
      };

      const onAbort = () => {
        this.resolve(id, { status: "cancelled", reason: "Aborted" });
      };

      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.localPending.set(id, entry);
      this.host.register(entry, {
        resolve: (res) => {
          options?.signal?.removeEventListener("abort", onAbort);
          cleanup();
          resolve(res as InteractionResult<TRes>);
        },
      });
    });
  }

  resolve(id: string, result: InteractionResult): boolean {
    this.localPending.delete(id);
    return this.host.resolve(id, result);
  }
}

export function useInteractionHandlers(): void {
  const host = inject(InteractionHostService);
  inject(StateSyncServerService).useHandlers(InteractionStateSyncContract, {
    active: () => host.active,
  });
}
