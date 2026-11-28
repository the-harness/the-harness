import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type SessionDigestModule = typeof import("../../packages/session-digest/src/index.ts");
type SessionDigestNodeModule = typeof import("../../packages/session-digest/src/node.ts");
type SqliteModule = typeof import("../../packages/sqlite/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let digestModule: SessionDigestModule;
let digestNodeModule: SessionDigestNodeModule;
let sqlite: SqliteModule;
let noteField: { readonly name: string };
let tempDir: string;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, digestModule, digestNodeModule, sqlite] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<SessionDigestModule>("/packages/session-digest/src/index.ts"),
    harness.load<SessionDigestNodeModule>("/packages/session-digest/src/node.ts"),
    harness.load<SqliteModule>("/packages/sqlite/src/index.ts"),
  ]);
  noteField = digestModule.SessionDigest.defineField<string>("test:session-digest:note");
  tempDir = mkdtempSync(join(tmpdir(), "harness-session-digest-"));
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await harness.close();
});

function openStore(path: string, options: { errors?: unknown[] } = {}) {
  const scope = di.createRootScope();
  scope.provideAll([
    di.createDescriptor(sqlite.SqliteService, { path }),
    di.createDescriptor(digestNodeModule.SessionDigestStore, {
      onError: (error: unknown) => options.errors?.push(error),
    }),
  ]);
  const sqliteService = scope.get(sqlite.SqliteService);
  const store = scope.get(digestNodeModule.SessionDigestStore);
  return {
    scope,
    store,
    async close() {
      await store.flush();
      await sqliteService.close();
      scope.dispose();
    },
  };
}

describe("session digest", () => {
  it("keeps per-session fields isolated and supports delete", async () => {
    const opened = openStore(join(tempDir, "isolated.db"));
    try {
      const first = opened.store.get("session-a");
      const second = opened.store.get("session-b");

      expect(first).not.toBe(second);
      expect(first.has(noteField)).toBe(false);
      first.set(noteField, "alpha");
      expect(first.get(noteField)).toBe("alpha");
      expect(second.get(noteField)).toBeUndefined();
      expect(first.delete(noteField)).toBe(true);
      expect(first.delete(noteField)).toBe(false);
      expect(opened.store.digests.get("session-a")).toBe(first);
    } finally {
      await opened.close();
    }
  });

  it("keeps digest membership synchronized through store-owned changes", async () => {
    const [status, statusNode] = await Promise.all([
      harness.load<typeof import("../../packages/session-status/src/index.ts")>(
        "/packages/session-status/src/index.ts",
      ),
      harness.load<typeof import("../../packages/session-status/src/node.ts")>(
        "/packages/session-status/src/node.ts",
      ),
    ]);
    const path = join(tempDir, "membership.db");
    const opened = openStore(path);
    try {
      opened.scope.provide(statusNode.SessionStatusHostService);
      const { active } = opened.scope.get(statusNode.SessionStatusHostService);
      const kept = opened.store.get("kept");
      const completed = status.CompletedSessionStatus.create();
      kept.set(status.sessionStatusField, completed);
      expect(active.items.get("kept")).toBe(completed);

      const view = opened.store.digests as Map<string, typeof kept>;
      view.set("untracked", kept);
      expect(view.delete("kept")).toBe(false);
      view.clear();
      expect([...view.keys()]).toEqual(["kept"]);
      expect([...active.items.keys()]).toEqual(["kept"]);

      expect(view.get("kept")).toBe(kept);
      const failed = status.FailedSessionStatus.create({ message: "updated from the view" });
      view.get("kept")!.set(status.sessionStatusField, failed);
      expect(active.items.get("kept")).toBe(failed);

      opened.store.get("removed").set(status.sessionStatusField, completed);
      expect(active.items.get("removed")).toBe(completed);
      await opened.store.flush();
      expect(opened.store.delete("removed")).toBe(true);
      expect(view.has("removed")).toBe(false);
      expect(active.items.has("removed")).toBe(false);
    } finally {
      await opened.close();
    }

    const reopened = openStore(path);
    try {
      expect([...reopened.store.digests.keys()]).toEqual(["kept"]);
      expect(reopened.store.digests.get("kept")?.get(status.sessionStatusField)).toMatchObject({
        message: "updated from the view",
      });
    } finally {
      await reopened.close();
    }
  });

  it("persists edits after the session that opened the digest is disposed", async () => {
    const path = join(tempDir, "session-lifetime.db");
    const writer = openStore(path);
    try {
      const session = writer.scope.createChild();
      session.provide(di.createDescriptor(digestNodeModule.SessionDigestService, { id: "a" }));
      session.get(digestNodeModule.SessionDigestService).set(noteField, "first");
      session.dispose();
      writer.store.get("a").set(noteField, "later");
    } finally {
      await writer.close();
    }

    const reader = openStore(path);
    try {
      expect(reader.store.digests.get("a")?.get(noteField)).toBe("later");
    } finally {
      await reader.close();
    }
  });

  it("restores digests initialized or recreated by synchronous membership observers", async () => {
    const { watchSyncEffect } = await harness.load<typeof import("reactivity")>(
      "/packages/llm/node_modules/reactivity/dist/index.js",
    );
    const path = join(tempDir, "membership-observers.db");
    const writer = openStore(path);
    try {
      const old = writer.store.get("replaced").set(noteField, "old");
      writer.scope.run(() =>
        watchSyncEffect(() => {
          writer.store.digests.get("added")?.set(noteField, "initialized");
          if (!writer.store.digests.has("replaced")) {
            writer.store.get("replaced").set(noteField, "new");
          }
        }),
      );
      writer.store.get("added");
      expect(writer.store.delete("replaced")).toBe(true);
      old.set(noteField, "stale");
    } finally {
      await writer.close();
    }

    const reader = openStore(path);
    try {
      expect(reader.store.digests.get("added")?.get(noteField)).toBe("initialized");
      expect(reader.store.digests.get("replaced")?.get(noteField)).toBe("new");
    } finally {
      await reader.close();
    }
  });

  it("derives hook values while leaving the base value as the terminal fallback", async () => {
    const opened = openStore(join(tempDir, "hooks.db"));
    try {
      const digest = opened.store.get("session-a");
      const slot = digest.hook(noteField);
      const seen: string[] = [];
      const anchor = opened.scope.run(() =>
        slot.use((_input, next) => {
          const base = next();
          if (base !== undefined) seen.push(base);
          return base === undefined ? undefined : `derived:${base}`;
        }),
      );
      expect(anchor).toBeDefined();
      expect(digest.get(noteField)).toBeUndefined();

      digest.set(noteField, "alpha");
      expect(digest.get(noteField)).toBe("derived:alpha");
      expect(digest.has(noteField)).toBe(true);
      expect(seen).toContain("alpha");

      digest.delete(noteField);
      expect(digest.get(noteField)).toBeUndefined();
    } finally {
      await opened.close();
    }
  });

  it("persists base and derived values and restores them in a new store", async () => {
    const path = join(tempDir, "persisted.db");
    const first = openStore(path);
    const firstDigest = first.store.get("session-a");
    firstDigest.set(noteField, "alpha");
    first.scope.run(() =>
      firstDigest.hook(noteField).use((_input, next) => {
        const base = next();
        return base === undefined ? undefined : `${base}-derived`;
      }),
    );
    firstDigest.set(noteField, "beta");
    expect(firstDigest.get(noteField)).toBe("beta-derived");
    await first.close();

    const second = openStore(path);
    try {
      const restored = second.store.get("session-a");
      expect(restored.get(noteField)).toBe("beta-derived");

      restored.set(noteField, "gamma");
      expect(restored.get(noteField)).toBe("gamma");
    } finally {
      await second.close();
    }
  });

  it("persists deletion and reports rows that cannot be parsed", async () => {
    const path = join(tempDir, "deleted.db");
    const first = openStore(path);
    first.store.get("session-a").set(noteField, "alpha");
    first.store.get("session-b").set(noteField, "beta");
    expect(first.store.delete("session-a")).toBe(true);
    expect(first.store.delete("missing")).toBe(false);
    await first.close();

    const second = openStore(path);
    expect(second.store.digests.has("session-a")).toBe(false);
    expect(second.store.get("session-b").get(noteField)).toBe("beta");
    await second.close();

    const errors: unknown[] = [];
    const third = openStore(path, { errors });
    third.scope
      .get(sqlite.SqliteService)
      .write(() => [
        [
          "INSERT INTO session_digests (id, digest, updated_at) VALUES (?, ?, ?)",
          "broken",
          "{not-json",
          1,
        ],
      ]);
    await third.close();

    const fourth = openStore(path, { errors });
    try {
      expect(fourth.store.digests.has("broken")).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    } finally {
      await fourth.close();
    }
  });

  it("stops deriving after the session is deleted", async () => {
    const opened = openStore(join(tempDir, "dispose.db"));
    try {
      const digest = opened.store.get("session-a");
      opened.scope.run(() =>
        digest.hook(noteField).use((_input, next) => {
          const base = next();
          return base === undefined ? undefined : `derived:${base}`;
        }),
      );
      digest.set(noteField, "alpha");
      expect(digest.get(noteField)).toBe("derived:alpha");

      opened.store.delete("session-a");
      digest.set(noteField, "beta");
      expect(digest.get(noteField)).toBe("beta");
    } finally {
      await opened.close();
    }
  });
});
