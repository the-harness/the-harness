import { inject } from "@harness/di";
import { SqliteService } from "@harness/sqlite";
import { z } from "zod";
import {
  applyEnvironmentEdit,
  environmentUpdates,
  restoreEnvironment,
  type EnvironmentEntry,
} from "../environment-edits.ts";
import type { ExtensionHostService } from "../service.ts";

export function registerEnvironmentStorage(host: ExtensionHostService): void {
  const sqlite = inject(SqliteService);
  sqlite.createTable(
    "extension_environments",
    "storage_file TEXT PRIMARY KEY, entries TEXT NOT NULL",
  );
  const entries = new Map(
    sqlite
      .read<{ storage_file: string; entries: string }>(
        "SELECT storage_file, entries FROM extension_environments",
      )
      .map((row) => [row.storage_file, row.entries] as const),
  );
  host.registerMainThreadRouter(async (_session, method, args) => {
    if (method === "environment.load") {
      return { handled: true, value: entries.get(z.string().parse(args[0])) };
    }
    if (method !== "environment.save") return { handled: false };
    const updates = environmentUpdates.parse(args[0]);
    const snapshots = new Map<string, string>();
    sqlite.write(() => {
      const changed = new Map<string, Map<string, EnvironmentEntry>>();
      for (const { file, legacy, edit } of updates) {
        let values = changed.get(file);
        if (!values) {
          values = restoreEnvironment(entries.get(file) ?? legacy ?? "[]");
          changed.set(file, values);
        }
        applyEnvironmentEdit(values, edit);
      }
      return Array.from(changed, ([file, values]) => {
        const raw = JSON.stringify([...values.values()]);
        snapshots.set(file, raw);
        return [
          "INSERT OR REPLACE INTO extension_environments (storage_file, entries) VALUES (?, ?)",
          file,
          raw,
        ] as const;
      });
    });
    for (const [file, raw] of snapshots) entries.set(file, raw);
    await sqlite.flush();
    return { handled: true };
  });
}
