import { inject, InstantiationService } from "@harness/di";
import type { StorageLike } from "@vueuse/core";
import { computed, effectScope, onScopeDispose, reactive, type EffectScope, type Ref } from "vue";
import { z } from "zod";
import { LocalSync, removeKeysByPrefix, type StorageSync } from "./sync.ts";

export type StorageFields = Record<string, z.ZodType>;

export type StorageState<TFields extends StorageFields> = {
  -readonly [K in keyof TFields]: z.output<TFields[K]>;
};

export interface UiStorageServiceOptions {
  readonly prefix?: string;
  readonly localStorage?: StorageLike;
  readonly sessionStorage?: StorageLike;
  readonly onError?: (error: unknown) => void;
}

interface EntryRecord {
  readonly state: StorageState<StorageFields>;
  readonly ref: Ref<Record<string, unknown>>;
  readonly sync: StorageSync;
  readonly key: string;
  readonly scope: EffectScope;
  readonly defaultValue: () => Record<string, unknown>;
}

interface SharedStorageRuntime {
  readonly instantiation: InstantiationService;
  readonly localStorage: StorageLike;
  readonly sessionStorage: StorageLike;
  readonly onError?: (error: unknown) => void;
  readonly buckets: Map<string, Map<string, EntryRecord>>;
  readonly syncs: Set<StorageSync>;
}

const NAMESPACE_PATTERN = /^[^:]+:[^:]+(:[^:]+)*$/;

function assertValidNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`Storage namespace "${namespace}" must be scoped as "<author>:<package>"`);
  }
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

export class UiStorageService {
  readonly prefix: string;
  readonly localStorage: StorageLike;
  readonly sessionStorage: StorageLike;

  private readonly runtime: SharedStorageRuntime;

  constructor(options: UiStorageServiceOptions = {}, sharedRuntime?: SharedStorageRuntime) {
    this.prefix = options.prefix ?? "harness";
    if (sharedRuntime !== undefined) {
      this.runtime = sharedRuntime;
      this.localStorage = sharedRuntime.localStorage;
      this.sessionStorage = sharedRuntime.sessionStorage;
      return;
    }

    this.localStorage =
      options.localStorage ??
      (typeof window !== "undefined" ? window.localStorage : createMemoryStorage());
    this.sessionStorage =
      options.sessionStorage ??
      (typeof window !== "undefined" ? window.sessionStorage : createMemoryStorage());

    const runtime: SharedStorageRuntime = {
      instantiation: inject(InstantiationService),
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      onError: options.onError,
      buckets: new Map(),
      syncs: new Set(),
    };
    this.runtime = runtime;

    onScopeDispose(() => {
      for (const bucket of runtime.buckets.values()) {
        for (const entry of bucket.values()) {
          entry.scope.stop();
        }
        bucket.clear();
      }
      runtime.buckets.clear();
      runtime.syncs.clear();
    });
  }

  scope(...segments: string[]): UiStorageService {
    const clean = segments.filter(Boolean).join(":");
    const nextPrefix = clean ? `${this.prefix}:${clean}` : this.prefix;
    return new UiStorageService({ prefix: nextPrefix }, this.runtime);
  }

  use<TFields extends StorageFields>(
    namespace: string,
    fields: TFields,
    sync: StorageSync = new LocalSync(),
  ): StorageState<TFields> {
    assertValidNamespace(namespace);
    const bucket = this.getBucket();
    const existing = bucket.get(namespace);
    if (existing !== undefined) {
      return existing.state as StorageState<TFields>;
    }

    const schema = z.object(fields);
    const defaultValue = (): Record<string, unknown> => {
      const parsed = schema.safeParse({});
      if (!parsed.success) {
        throw new Error(`Storage state "${namespace}" must declare Zod .default() for all fields`);
      }
      return parsed.data as Record<string, unknown>;
    };
    defaultValue();

    const key = `${this.prefix}:${namespace}`;
    this.runtime.syncs.add(sync);

    const entryScope = effectScope(true);
    const valueRef = entryScope.run(() =>
      sync.connect<Record<string, unknown>>({
        key,
        schema: schema as unknown as z.ZodType<Record<string, unknown>>,
        defaultValue,
        storage: this,
        instantiation: this.runtime.instantiation,
        onError: this.runtime.onError,
      }),
    )!;

    const props: Record<string, Ref<unknown>> = {};
    for (const fieldName of Object.keys(fields)) {
      props[fieldName] = computed({
        get: () => valueRef.value[fieldName],
        set: (next) => {
          valueRef.value = { ...valueRef.value, [fieldName]: next };
        },
      });
    }
    const state = reactive(props) as StorageState<TFields>;

    bucket.set(namespace, {
      state,
      ref: valueRef,
      sync,
      key,
      scope: entryScope,
      defaultValue,
    });

    return state;
  }

  delete(namespace: string): void {
    const bucket = this.runtime.buckets.get(this.prefix);
    const entry = bucket?.get(namespace);
    if (entry !== undefined) {
      entry.ref.value = entry.defaultValue();
      entry.scope.stop();
      entry.sync.delete?.(entry.key, this);
      bucket?.delete(namespace);
      return;
    }
    const key = `${this.prefix}:${namespace}`;
    this.localStorage.removeItem(key);
    this.sessionStorage.removeItem(key);
  }

  clear(): void {
    const bucket = this.runtime.buckets.get(this.prefix);
    if (bucket !== undefined) {
      for (const entry of bucket.values()) {
        entry.scope.stop();
      }
      bucket.clear();
      this.runtime.buckets.delete(this.prefix);
    }
    const prefix = `${this.prefix}:`;
    removeKeysByPrefix(this.localStorage, prefix);
    removeKeysByPrefix(this.sessionStorage, prefix);
    for (const sync of this.runtime.syncs) {
      sync.clearScope?.(prefix, this);
    }
  }

  private getBucket(): Map<string, EntryRecord> {
    let bucket = this.runtime.buckets.get(this.prefix);
    if (bucket === undefined) {
      bucket = new Map();
      this.runtime.buckets.set(this.prefix, bucket);
    }
    return bucket;
  }
}
