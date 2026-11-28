import { inject } from "@harness/di";
import { SqliteService } from "@harness/sqlite";
import { defaultDeserialize, SyncedArrayHost } from "@harness/state-sync";
import { WorkspaceSchema, type Workspace } from "./types.ts";

export * from "./types.ts";

// Ordered list of workspaces, persisted in SQLite; `host` is what clients sync.
export class WorkspaceCatalog {
  readonly host: SyncedArrayHost<Workspace>;

  get items(): readonly Workspace[] {
    return this.host.items;
  }

  // Falls back to the first workspace when the given one is missing.
  resolve(id: string | undefined): Workspace | undefined {
    return this.items.find((item) => item.id === id) ?? this.items[0];
  }

  constructor() {
    const sqlite = inject(SqliteService);
    sqlite.createTable(
      "workspaces",
      `
      position INTEGER NOT NULL,
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folders TEXT NOT NULL,
      instructions TEXT NOT NULL
    `,
    );

    const rows = sqlite.read<{
      id: string;
      name: string;
      folders: string;
      instructions: string;
    }>("SELECT id, name, folders, instructions FROM workspaces ORDER BY position ASC");

    const initial: Workspace[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      folders: JSON.parse(row.folders) as string[],
      instructions: row.instructions,
    }));

    const persist = (items: readonly Workspace[]) => {
      sqlite.write(() => [
        ["DELETE FROM workspaces"],
        ...items.map(
          (item, index) =>
            [
              "INSERT INTO workspaces (position, id, name, folders, instructions) VALUES (?, ?, ?, ?, ?)",
              index,
              item.id,
              item.name,
              JSON.stringify(item.folders),
              item.instructions,
            ] as const,
        ),
      ]);
    };

    this.host = new SyncedArrayHost(initial, {
      deserialize: (raw) => WorkspaceSchema.parse(defaultDeserialize(raw)),
    });
    this.host.subscribe(({ ops }) => {
      if (ops.length > 0) persist(this.host.items);
    });
  }
}
