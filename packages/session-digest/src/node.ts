import { inject } from "@harness/di";
import type { HookSlot } from "@harness/hooks";
import { SqliteService } from "@harness/sqlite";
import type { FieldKey } from "@harness/variants";
import {
  effectScope,
  onScopeDispose,
  shallowReactive,
  shallowReadonly,
  watchEffect,
  type EffectScope,
} from "reactivity";
import { SessionDigest } from "./index.ts";
import {
  deserializeValue,
  disposeHooksSymbol,
  hydrateDerivedSymbol,
  isPlainObject,
  serializeSnapshotSymbol,
  type SerializedDigestSnapshot,
} from "./internal.ts";

interface SessionDigestRow {
  readonly id: string;
  readonly digest: string;
}

export interface SessionDigestStoreOptions {
  readonly onError?: (error: unknown) => void;
}

export class SessionDigestStore {
  readonly digests: ReadonlyMap<string, SessionDigest>;

  protected readonly sqlite = inject(SqliteService);
  protected readonly digestMap = shallowReactive(new Map<string, SessionDigest>());
  private readonly tracking = new Map<SessionDigest, EffectScope>();

  constructor(options: SessionDigestStoreOptions = {}) {
    this.digests = shallowReadonly(this.digestMap);

    this.sqlite.createTable(
      "session_digests",
      `
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, updated_at INTEGER NOT NULL
    `,
    );
    const rows = this.sqlite.read<SessionDigestRow>(
      "SELECT id, digest FROM session_digests ORDER BY updated_at ASC",
    );

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.digest) as SerializedDigestSnapshot & Record<string, unknown>;
        const isStructured =
          isPlainObject(parsed) &&
          ("base" in parsed || "derived" in parsed) &&
          Object.keys(parsed).every((k) => k === "base" || k === "derived");
        const baseRaw = isStructured ? parsed.base : parsed;
        const derivedRaw = isStructured ? parsed.derived : undefined;
        const instance = SessionDigest.deserialize(baseRaw, deserializeValue);
        instance[hydrateDerivedSymbol](derivedRaw);
        this.add(row.id, instance);
      } catch (error) {
        options.onError?.(error);
      }
    }

    onScopeDispose(() => {
      for (const [digest, scope] of this.tracking) {
        scope.stop();
        digest[disposeHooksSymbol]();
      }
      this.tracking.clear();
    });
  }

  get(sessionId: string): SessionDigest {
    return this.digestMap.get(sessionId) ?? this.add(sessionId, new SessionDigest());
  }

  delete(sessionId: string): boolean {
    const existing = this.digestMap.get(sessionId);
    if (!existing) return false;
    this.sqlite.write(() => [["DELETE FROM session_digests WHERE id = ?", sessionId]]);
    this.tracking.get(existing)?.stop();
    this.tracking.delete(existing);
    existing[disposeHooksSymbol]();
    return this.digestMap.delete(sessionId);
  }

  flush(): Promise<void> {
    return this.sqlite.flush();
  }

  private add(sessionId: string, instance: SessionDigest): SessionDigest {
    let lastRaw: string | null | undefined;
    const serialize = () => {
      const snapshot = instance[serializeSnapshotSymbol]();
      return snapshot === undefined ? null : JSON.stringify(snapshot);
    };
    const persist = () => {
      if (lastRaw === undefined) {
        lastRaw = serialize();
        return;
      }
      this.sqlite.write(() => {
        const raw = serialize();
        if (raw === lastRaw) return [];
        lastRaw = raw;
        if (raw === null) return [["DELETE FROM session_digests WHERE id = ?", sessionId]];
        return [
          [
            `INSERT INTO session_digests (id, digest, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`,
            sessionId,
            raw,
            Date.now(),
          ],
        ];
      });
    };
    const scope = effectScope(true);
    scope.run(() => watchEffect(persist, { flush: "sync" }));
    this.tracking.set(instance, scope);
    this.digestMap.set(sessionId, instance);
    return instance;
  }
}

export interface SessionDigestServiceOptions {
  readonly id: string;
}

export class SessionDigestService {
  readonly id: string;
  readonly digest: SessionDigest;

  protected readonly store = inject(SessionDigestStore);

  constructor(options: SessionDigestServiceOptions) {
    this.id = options.id;
    this.digest = this.store.get(this.id);
  }

  get<TValue>(key: FieldKey<SessionDigest, TValue>): TValue | undefined {
    return this.digest.get(key);
  }

  has<TValue>(key: FieldKey<SessionDigest, TValue>): boolean {
    return this.digest.has(key);
  }

  set<TValue>(key: FieldKey<SessionDigest, TValue>, value: TValue): this {
    this.digest.set(key, value);
    return this;
  }

  delete<TValue>(key: FieldKey<SessionDigest, TValue>): boolean {
    return this.digest.delete(key);
  }

  hook<TValue>(key: FieldKey<SessionDigest, TValue>): HookSlot<void, TValue | undefined> {
    return this.digest.hook(key);
  }
}
