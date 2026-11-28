import { resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import type { SessionInfo, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Context } from "@harness/context";
import { createDescriptor, type Scope } from "@harness/di";
import type { Message } from "@harness/llm";
import { SqliteService, type SqliteMutation } from "@harness/sqlite";
import { toPiMessages, type PiMessage } from "./extension-content.ts";
import type { SessionTreeState } from "./session-tree.ts";

type SessionLoader = ConstructorParameters<typeof SessionSelectorComponent>[0];
type SessionListProgress = Parameters<SessionLoader>[0];

interface SessionRow {
  readonly id: string;
  readonly cwd: string;
  readonly parent_id: string | null;
  readonly name: string | null;
  readonly created_at: number | null;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly model_provider: string | null;
  readonly model_id: string | null;
  readonly thinking: string | null;
}

interface SavedSelection {
  readonly provider: string;
  readonly model: string;
  readonly thinking: string | undefined;
}

const sessionColumns = {
  parent_id: "TEXT",
  name: "TEXT",
  created_at: "INTEGER",
  deleted_at: "INTEGER",
  model_provider: "TEXT",
  model_id: "TEXT",
  thinking: "TEXT",
};
const columnQuery = "SELECT name FROM pragma_table_info('pi_cli_sessions')";

export function initializeSessionCatalog(sqlite: SqliteService, database: string): void {
  const definitions = Object.entries(sessionColumns);
  sqlite.createTable(
    "pi_cli_sessions",
    [
      "id TEXT PRIMARY KEY",
      "cwd TEXT NOT NULL",
      "updated_at INTEGER NOT NULL",
      ...definitions.map(([name, type]) => `${name} ${type}`),
    ].join(", "),
  );
  sqlite.createTable("pi_cli_trees", "session_id TEXT PRIMARY KEY, state TEXT NOT NULL");

  const existing = new Set(sqlite.read<{ name: string }>(columnQuery).map(({ name }) => name));
  if (definitions.every(([name]) => existing.has(name))) return;
  // Recheck the legacy schema under a write lock so concurrent launches can migrate the same file.
  const migration = new DatabaseSync(database);
  try {
    migration.exec("PRAGMA busy_timeout = 5000; PRAGMA fullfsync = ON; BEGIN IMMEDIATE");
    const columns = new Set(
      migration
        .prepare(columnQuery)
        .all()
        .map(({ name }) => name),
    );
    for (const [name, type] of definitions) {
      if (!columns.has(name))
        migration.exec(`ALTER TABLE pi_cli_sessions ADD COLUMN ${name} ${type}`);
    }
    migration.exec("COMMIT");
  } finally {
    migration.close();
  }
}

export async function readSessionHistory(
  context: Context,
  signal?: AbortSignal,
): Promise<readonly Message[]> {
  const batches: (readonly Message[])[] = [];
  for await (const batch of context.readBackward()) {
    signal?.throwIfAborted();
    batches.push(batch.messages);
  }
  return [...batches.reverse().flat(), ...context.pending];
}

export function sessionMessageCount(messages: readonly PiMessage[]): number {
  // Pi appends one system message entry; Context keeps one message per prompt section.
  const systems = messages.filter((message) => message.role === "system").length;
  return messages.length - Math.max(0, systems - 1);
}

export function createSessionCatalog(root: Scope, database: string) {
  const sqlite = root.get(SqliteService);
  const store = database === ":memory:" ? database : resolvePath(database);

  // Sessions share one store file, so pi's per-session path becomes "<store>#<id>":
  // it still locates the data and stays unique for pi's path-keyed tree.
  function reference(id: string): string {
    return `${store}#${id}`;
  }

  function referenceId(value: string): string {
    const prefix = `${store}#`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }

  async function write(...mutations: SqliteMutation[]): Promise<void> {
    sqlite.write(() => mutations);
    await sqlite.flush();
  }

  function get(id: string): SessionRow | undefined {
    return sqlite.read<SessionRow>("SELECT * FROM pi_cli_sessions WHERE id = ?", id)[0];
  }

  function owns(value: string): boolean {
    return get(referenceId(value)) !== undefined;
  }

  function latest(cwd: string): SessionRow | undefined {
    return sqlite.read<SessionRow>(
      `
      SELECT * FROM pi_cli_sessions WHERE cwd = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `,
      cwd,
    )[0];
  }

  function resolve(reference: string, cwd: string): SessionRow {
    const value = referenceId(reference);
    if (value.length === 0) throw new Error("A session ID is required");
    const exact = get(value);
    if (exact) {
      if (exact.deleted_at !== null) throw new Error(`Session '${exact.id}' is in the trash`);
      return exact;
    }
    const matches = sqlite.read<SessionRow>(
      `
      SELECT * FROM pi_cli_sessions WHERE substr(id, 1, length(?)) = ? AND deleted_at IS NULL
    `,
      value,
      value,
    );
    const local = matches.filter((row) => row.cwd === cwd);
    const available = local.length > 0 ? local : matches;
    if (available.length > 1) throw new Error(`Ambiguous session ID '${value}'`);
    if (!available[0]) throw new Error(`No session found matching '${value}'`);
    return available[0];
  }

  async function list(
    cwd: string | undefined,
    onProgress?: SessionListProgress,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    await sqlite.flush();
    signal?.throwIfAborted();
    const rows = sqlite.read<SessionRow & { branch_id: string | null }>(
      `
      SELECT sessions.*, json_extract(trees.state, '$.branchId') AS branch_id
      FROM pi_cli_sessions AS sessions
      LEFT JOIN pi_cli_trees AS trees ON trees.session_id = sessions.id
      WHERE (? IS NULL OR sessions.cwd = ?) AND sessions.deleted_at IS NULL
      ORDER BY sessions.updated_at DESC, sessions.rowid DESC
    `,
      cwd ?? null,
      cwd ?? null,
    );
    const known = new Set(
      sqlite.read<{ id: string }>("SELECT id FROM pi_cli_sessions").map(({ id }) => id),
    );
    const sessions: SessionInfo[] = [];
    for (const [index, row] of rows.entries()) {
      signal?.throwIfAborted();
      const scope = root.createChild();
      try {
        scope.provide(createDescriptor(Context, { id: row.branch_id ?? row.id }));
        const messages = toPiMessages(await readSessionHistory(scope.get(Context), signal));
        const text = messages.flatMap((message) => {
          if (message.role !== "user" && message.role !== "assistant") return [];
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join(" ");
          return content ? [{ role: message.role, content }] : [];
        });
        sessions.push({
          id: row.id,
          path: reference(row.id),
          cwd: row.cwd,
          name: row.name ?? undefined,
          parentSessionPath:
            row.parent_id !== null && known.has(row.parent_id)
              ? reference(row.parent_id)
              : (row.parent_id ?? undefined),
          created: new Date(
            row.created_at ??
              messages.find((message) => message.timestamp > 0)?.timestamp ??
              row.updated_at,
          ),
          modified: new Date(row.updated_at),
          messageCount: sessionMessageCount(messages),
          firstMessage: text.find((message) => message.role === "user")?.content ?? "(no messages)",
          allMessagesText: text.map((message) => message.content).join(" "),
        });
      } finally {
        scope.dispose();
      }
      const loaded = index + 1;
      const partial = loaded === 1 || loaded % 10 === 0;
      onProgress?.(loaded, rows.length, partial ? [...sessions] : undefined);
      if (partial) await setImmediate(undefined, { signal });
    }
    return sessions;
  }

  function getTree(id: string): SessionTreeState | undefined {
    const row = sqlite.read<{ state: string }>(
      "SELECT state FROM pi_cli_trees WHERE session_id = ?",
      id,
    )[0];
    return row ? (JSON.parse(row.state) as SessionTreeState) : undefined;
  }

  return {
    get,
    owns,
    latest,
    resolve,
    reference,
    referenceId,
    list,
    getTree,
    saveTree(id: string, state: SessionTreeState) {
      return write([
        `
          INSERT INTO pi_cli_trees (session_id, state) VALUES (?, ?)
          ON CONFLICT(session_id) DO UPDATE SET state = excluded.state
        `,
        id,
        JSON.stringify(state),
      ]);
    },
    async createFork(session: {
      id: string;
      cwd: string;
      parent: string;
      name?: string;
      provider?: string;
      model?: string;
      thinking?: string;
      tree: SessionTreeState;
    }) {
      const now = Date.now();
      await write(
        [
          `
          INSERT INTO pi_cli_sessions (id, cwd, parent_id, name, created_at, updated_at, model_provider, model_id, thinking)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `,
          session.id,
          session.cwd,
          session.parent,
          session.name ?? null,
          now,
          now,
          session.provider ?? null,
          session.model ?? null,
          session.thinking ?? null,
        ],
        [
          "INSERT INTO pi_cli_trees (session_id, state) SELECT ?, ? WHERE changes() = 1",
          session.id,
          JSON.stringify(session.tree),
        ],
      );
      if (getTree(session.id)?.branchId !== session.tree.branchId) {
        throw new Error(`Session already exists with id '${session.id}'`);
      }
    },
    remember(
      session: SavedSelection & {
        id: string;
        cwd: string;
        parent?: string;
        name?: string;
        createdAt: number;
      },
    ) {
      return write([
        `
          INSERT INTO pi_cli_sessions (id, cwd, updated_at, parent_id, name, created_at, model_provider, model_id, thinking)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
            created_at = COALESCE(pi_cli_sessions.created_at, excluded.created_at),
            model_provider = excluded.model_provider,
            model_id = excluded.model_id,
            thinking = excluded.thinking
        `,
        session.id,
        session.cwd,
        Date.now(),
        session.parent ?? null,
        session.name ?? null,
        session.createdAt,
        session.provider,
        session.model,
        session.thinking ?? null,
      ]);
    },
    saveSelection(id: string, selection: SavedSelection) {
      return write([
        `
          UPDATE pi_cli_sessions SET model_provider = ?, model_id = ?, thinking = ?
          WHERE id = ? AND deleted_at IS NULL
        `,
        selection.provider,
        selection.model,
        selection.thinking ?? null,
        id,
      ]);
    },
    rename(id: string, name: string | undefined) {
      return write([
        "UPDATE pi_cli_sessions SET name = ? WHERE id = ? AND deleted_at IS NULL",
        name ?? null,
        id,
      ]);
    },
    remove(id: string) {
      return write([
        "UPDATE pi_cli_sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        Date.now(),
        id,
      ]);
    },
  };
}

export type SessionCatalog = ReturnType<typeof createSessionCatalog>;
