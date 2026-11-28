import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it } from "vite-plus/test";

it("opens the SQLite service while another connection is releasing its startup lock", async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "sqlite-wal-"));
  const path = join(directory, "sessions.sqlite");
  const seed = new DatabaseSync(path);
  const workers: Worker[] = [];
  try {
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('existing');
      BEGIN IMMEDIATE;
    `);
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(join(process.cwd(), "tests/sqlite/wal-startup.worker.ts"), {
        workerData: path,
        execArgv: [],
      });
      workers.push(worker);
    }
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const results = Promise.all(workers.map((worker) => once(worker, "message")));
    for (const worker of workers) worker.postMessage("open");
    const release = setTimeout(() => seed.exec("ROLLBACK"), 100);
    try {
      for (const [result] of await results) {
        expect(result).toEqual({ mode: "wal", ids: ["existing"], timeout: 5000 });
      }
    } finally {
      clearTimeout(release);
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    seed.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
