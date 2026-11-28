import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { onScopeDispose } from "reactivity";

const busyTimeoutMs = 5000;
const sqliteBusy = 5;

function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + busyTimeoutMs;
  const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== sqliteBusy) {
        throw error;
      }
      const delay = Math.min(20, deadline - performance.now());
      if (delay > 0) Atomics.wait(wait, 0, 0, delay);
      if (performance.now() >= deadline) throw error;
    }
  }
}

export interface SqliteServiceOptions {
  readonly path: string;
}

export type SqliteMutation = readonly [sql: string, ...values: SQLInputValue[]];

interface WriteFailure {
  readonly error: unknown;
}

export class SqliteService {
  private readonly db: DatabaseSync;
  private batch?: SqliteMutation[][];
  private scheduled?: Promise<WriteFailure | undefined>;
  private failure?: WriteFailure;
  private closing = false;

  constructor(options: SqliteServiceOptions) {
    // WAL lock upgrades can skip SQLite's busy handler. Give the retry loop the whole startup budget.
    this.db = new DatabaseSync(options.path, { timeout: 0 });
    try {
      enableWal(this.db);
      this.db.exec(`
        PRAGMA busy_timeout = ${busyTimeoutMs};
        PRAGMA synchronous = FULL;
        PRAGMA fullfsync = ON;
      `);
    } catch (error) {
      try {
        this.db.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "SQLite initialization and cleanup failed");
      }
      throw error;
    }
    onScopeDispose(() => {
      if (!this.closing) void this.close().catch(console.error);
    });
  }

  createTable(name: string, definition: string): void {
    const table = name.replaceAll('"', '""');
    this.db.prepare(`CREATE TABLE IF NOT EXISTS "${table}" (${definition})`).run();
  }

  read<Row = Record<string, SQLOutputValue>>(sql: string, ...values: SQLInputValue[]): Row[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("Expected a SELECT query");
    this.db.exec("PRAGMA query_only = ON");
    try {
      return this.db.prepare(sql).all(...values) as Row[];
    } finally {
      this.db.exec("PRAGMA query_only = OFF");
    }
  }

  write(prepare: () => readonly SqliteMutation[]): void {
    this.throwIfFailed();
    try {
      if (this.closing) throw new Error("SQLite service is closing");
      if (!this.batch) {
        const batch: SqliteMutation[][] = [];
        this.batch = batch;
        this.scheduled = Promise.resolve().then(() => {
          this.batch = undefined;
          if (!this.failure) {
            const mutations = batch.flat();
            if (mutations.length) this.commit(mutations);
          }
          return this.failure;
        });
      }
      // prepare 可重入，先保留本次调用在批次中的位置。
      const mutations: SqliteMutation[] = [];
      this.batch.push(mutations);
      for (const [sql, ...values] of prepare()) {
        if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql)) {
          throw new Error("Expected a SQLite data mutation");
        }
        const parameters = values.map((value) =>
          ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
            : value,
        );
        mutations.push([sql, ...parameters]);
      }
      this.throwIfFailed();
    } catch (error) {
      this.failure = { error };
      throw error;
    }
  }

  async flush(): Promise<void> {
    const failure = this.failure ?? (await this.scheduled);
    if (failure) throw failure.error;
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.flush();
    } finally {
      if (this.db.isOpen) this.db.close();
    }
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error;
  }

  private commit(batch: SqliteMutation[]): void {
    const statements = new Map<string, StatementSync>();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const [sql, ...values] of batch) {
        let statement = statements.get(sql);
        if (!statement) {
          statement = this.db.prepare(sql);
          // prepare 只编译第一条语句。其余部分可以包含分号、空白和 SQL 注释。
          const tail = sql.slice(statement.sourceSQL.length);
          if (/[^\s;]/.test(tail.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, ""))) {
            throw new Error("Expected a single statement per SQLite mutation");
          }
          statements.set(sql, statement);
        }
        statement.run(...values);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.failure = { error };
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        this.db.close();
        this.failure = {
          error: new AggregateError([error, rollbackError], "SQLite rollback failed"),
        };
      }
      console.error("SQLite persistence stopped", this.failure.error);
    }
  }
}
