import { inject } from "@harness/di";
import { SqliteService } from "@harness/sqlite";
import { SyncedArrayHost } from "@harness/state-sync";
import { onScopeDispose } from "reactivity";
import type { SessionSummary } from "./types.ts";

export * from "./types.ts";

interface Row {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string | null;
  readonly created_at: number;
  readonly model_id: string | null;
  readonly preset_id: string | null;
  readonly meta: string | null;
}

// Sessions, newest first. Clients only read `host`; every change goes through the methods.
export class SessionCatalog {
  readonly host: SyncedArrayHost<SessionSummary>;

  private readonly sqlite = inject(SqliteService);
  private readonly createListeners = new Set<(id: string) => void>();
  private readonly removeListeners = new Set<(id: string) => void>();

  get items(): readonly SessionSummary[] {
    return this.host.items;
  }

  constructor() {
    this.sqlite.createTable(
      "session_catalog",
      "id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, " +
        "model_id TEXT, preset_id TEXT, meta TEXT",
    );
    const rows = this.sqlite.read<Row>(
      "SELECT * FROM session_catalog ORDER BY created_at DESC",
    );
    this.host = new SyncedArrayHost(rows.length > 0 ? rows.map(fromRow) : this.importLegacy());
    onScopeDispose(() => {
      this.createListeners.clear();
      this.removeListeners.clear();
    });
  }

  get(id: string): SessionSummary | undefined {
    return this.items.find((item) => item.id === id);
  }

  create(input: { readonly id?: string; readonly workspaceId: string }): SessionSummary {
    const id = input.id ?? crypto.randomUUID();
    const existing = this.get(id);
    if (existing) return existing;
    const summary: SessionSummary = { id, workspaceId: input.workspaceId, createdAt: Date.now() };
    this.host.items.unshift(summary);
    this.sqlite.write(() => [
      [
        "INSERT INTO session_catalog (id, workspace_id, created_at) VALUES (?, ?, ?)",
        id,
        summary.workspaceId,
        summary.createdAt,
      ],
    ]);
    for (const listener of [...this.createListeners]) listener(id);
    return summary;
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed) this.update(id, { title: trimmed });
  }

  // Only the given fields change.
  configure(id: string, config: { readonly modelId?: string; readonly presetId?: string }): void {
    const current = this.get(id);
    if (!current) return;
    this.update(id, {
      modelId: config.modelId ?? current.modelId,
      presetId: config.presetId ?? current.presetId,
    });
  }

  setMeta(id: string, meta: Record<string, unknown> | undefined): void {
    this.update(id, { meta: meta && Object.keys(meta).length > 0 ? meta : undefined });
  }

  remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    this.host.items.splice(index, 1);
    this.sqlite.write(() => [["DELETE FROM session_catalog WHERE id = ?", id]]);
    for (const listener of [...this.removeListeners]) listener(id);
  }

  onCreate(listener: (id: string) => void): () => void {
    this.createListeners.add(listener);
    return () => this.createListeners.delete(listener);
  }

  onRemove(listener: (id: string) => void): () => void {
    this.removeListeners.add(listener);
    return () => this.removeListeners.delete(listener);
  }

  private update(
    id: string,
    patch: Partial<Pick<SessionSummary, "title" | "modelId" | "presetId" | "meta">>,
  ): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const current = this.items[index]!;
    const next = { ...current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.host.items[index] = next;
    this.sqlite.write(() => [
      [
        "UPDATE session_catalog SET title = ?, model_id = ?, preset_id = ?, meta = ? WHERE id = ?",
        next.title ?? null,
        next.modelId ?? null,
        next.presetId ?? null,
        next.meta ? JSON.stringify(next.meta) : null,
        id,
      ],
    ]);
  }

  // The previous `sessions` table stored display strings and rewrote every row on each change.
  private importLegacy(): SessionSummary[] {
    const exists = this.sqlite.read(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    );
    if (exists.length === 0) return [];
    const now = Date.now();
    const legacy = this.sqlite.read<{
      id: string;
      workspace_id: string;
      title: string;
      meta: string | null;
    }>("SELECT id, workspace_id, title, meta FROM sessions ORDER BY position ASC");
    const items = legacy.map((row, index) =>
      fromRow({
        id: row.id,
        workspace_id: row.workspace_id,
        title: row.title === "New conversation" ? null : row.title,
        created_at: now - index,
        model_id: null,
        preset_id: null,
        meta: row.meta,
      }),
    );
    this.sqlite.write(() => [
      ...items.map(
        (item) =>
          [
            "INSERT INTO session_catalog (id, workspace_id, title, created_at, meta) VALUES (?, ?, ?, ?, ?)",
            item.id,
            item.workspaceId,
            item.title ?? null,
            item.createdAt,
            item.meta ? JSON.stringify(item.meta) : null,
          ] as const,
      ),
      ["DROP TABLE sessions"],
    ]);
    return items;
  }
}

function fromRow(row: Row): SessionSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.title !== null ? { title: row.title } : {}),
    createdAt: row.created_at,
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.preset_id !== null ? { presetId: row.preset_id } : {}),
    ...(row.meta ? { meta: JSON.parse(row.meta) as Record<string, unknown> } : {}),
  };
}
