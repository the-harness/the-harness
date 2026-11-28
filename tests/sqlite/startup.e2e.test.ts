import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("closes the SQLite handle if the database cannot be initialized", async () => {
  const artifacts = join(process.cwd(), "temp", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "sqlite-startup-"));
  const path = join(directory, "store.db");
  const harness = await createHarnessModules();
  try {
    const [di, sqlite] = await Promise.all([
      harness.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      harness.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
    ]);
    const scope = di.createRootScope();
    const descriptor = di.createDescriptor(sqlite.SqliteService, { path });
    try {
      writeFileSync(path, Buffer.alloc(512, "invalid SQLite header"));
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        expect(() => scope.provide(descriptor)).toThrow("file is not a database");
        const handle = exec.mock.contexts[0] as DatabaseSync | undefined;
        expect(handle?.isOpen).toBe(false);
      } finally {
        const handle = exec.mock.contexts[0] as DatabaseSync | undefined;
        exec.mockRestore();
        if (handle?.isOpen) handle.close();
      }
    } finally {
      scope.dispose();
    }

    rmSync(path);
    const reopened = di.createRootScope();
    try {
      reopened.provide(descriptor);
      const store = reopened.get(sqlite.SqliteService);
      try {
        expect(store.read("SELECT 1 AS value")).toEqual([{ value: 1 }]);
      } finally {
        await store.close();
      }
    } finally {
      reopened.dispose();
    }
  } finally {
    await harness.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
