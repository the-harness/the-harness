import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { createDescriptor, createRootScope } from "../../packages/di/src/index.ts";
import { SqliteService } from "../../packages/sqlite/src/index.ts";

if (!parentPort) throw new Error("Expected a worker thread");
const start = once(parentPort, "message");
parentPort.postMessage("ready");
await start;

const scope = createRootScope();
try {
  scope.provide(createDescriptor(SqliteService, { path: workerData }));
  const sqlite = scope.get(SqliteService);
  const [journal] = sqlite.read<{ journal_mode: string }>(
    "SELECT journal_mode FROM pragma_journal_mode",
  );
  const [busy] = sqlite.read<{ timeout: number }>("SELECT timeout FROM pragma_busy_timeout");
  const ids = sqlite.read<{ id: string }>("SELECT id FROM sessions").map((row) => row.id);
  await sqlite.close();
  parentPort.postMessage({ mode: journal?.journal_mode, ids, timeout: busy?.timeout });
} finally {
  scope.dispose();
}
