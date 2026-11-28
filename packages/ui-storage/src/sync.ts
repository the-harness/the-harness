import type { InstantiationService } from "@harness/di";
import { useStorage, type StorageLike } from "@vueuse/core";
import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { z } from "zod";
import type { UiStorageService } from "./storage.ts";

export interface StorageSyncContext<TValue> {
  readonly key: string;
  readonly schema: z.ZodType<TValue>;
  readonly defaultValue: () => TValue;
  readonly storage: UiStorageService;
  readonly instantiation: InstantiationService;
  readonly onError?: (error: unknown) => void;
}

export interface WebStorageSyncOptions {
  readonly writeDelayMs?: number;
}

/** 可拓展接口：实现自定义的存储或同步策略。 */
export abstract class StorageSync {
  abstract connect<TValue>(context: StorageSyncContext<TValue>): Ref<TValue>;
  delete?(key: string, storage: UiStorageService): void;
  clearScope?(prefix: string, storage: UiStorageService): void;
}

export class EphemeralSync extends StorageSync {
  override connect<TValue>(context: StorageSyncContext<TValue>): Ref<TValue> {
    return ref(context.defaultValue()) as Ref<TValue>;
  }
}

export function removeKeysByPrefix(storage: StorageLike, prefix: string): void {
  const webStorage = storage as StorageLike & {
    readonly length?: number;
    key?(index: number): string | null;
  };
  if (typeof webStorage.length !== "number" || typeof webStorage.key !== "function") {
    return;
  }
  const keys: string[] = [];
  for (let i = 0; i < webStorage.length; i++) {
    const key = webStorage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    storage.removeItem(key);
  }
}

function safeCloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : (JSON.parse(serialized) as T);
}

abstract class WebStorageSync extends StorageSync {
  protected readonly writeDelayMs: number;

  constructor(options: WebStorageSyncOptions = {}) {
    super();
    this.writeDelayMs = options.writeDelayMs ?? 0;
  }

  protected abstract resolveTarget(storage: UiStorageService): StorageLike;
  protected abstract get listenToStorageChanges(): boolean;

  override connect<TValue>(context: StorageSyncContext<TValue>): Ref<TValue> {
    const target = this.resolveTarget(context.storage);
    const persisted = useStorage<TValue>(context.key, context.defaultValue, target, {
      listenToStorageChanges: this.listenToStorageChanges,
      writeDefaults: false,
      onError: context.onError,
      serializer: {
        read: (raw) => {
          try {
            const parsed = JSON.parse(raw);
            const checked = context.schema.safeParse(parsed);
            if (checked.success) return checked.data;
          } catch {
            // Fall through to default when persisted JSON is malformed.
          }
          return context.defaultValue();
        },
        write: (value) => JSON.stringify(value),
      },
    }) as Ref<TValue>;

    if (this.writeDelayMs <= 0) {
      return persisted;
    }

    const buffered = ref(safeCloneJson(persisted.value)) as Ref<TValue>;
    let lastJson = JSON.stringify(buffered.value);
    let syncingFromStorage = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const nextJson = JSON.stringify(buffered.value);
      if (nextJson === lastJson) return;
      lastJson = nextJson;
      persisted.value = safeCloneJson(buffered.value);
    };

    watch(
      buffered,
      () => {
        if (syncingFromStorage) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, this.writeDelayMs);
      },
      { deep: true },
    );

    watch(
      persisted,
      (next) => {
        const nextJson = JSON.stringify(next);
        if (nextJson === lastJson) return;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        syncingFromStorage = true;
        try {
          lastJson = nextJson;
          buffered.value = safeCloneJson(next);
        } finally {
          syncingFromStorage = false;
        }
      },
      { deep: true },
    );

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", flush);
      onScopeDispose(() => {
        window.removeEventListener("pagehide", flush);
      });
    }
    onScopeDispose(flush);

    return buffered;
  }

  override delete(key: string, storage: UiStorageService): void {
    this.resolveTarget(storage).removeItem(key);
  }

  override clearScope(prefix: string, storage: UiStorageService): void {
    removeKeysByPrefix(this.resolveTarget(storage), prefix);
  }
}

export class TabSync extends WebStorageSync {
  protected override resolveTarget(storage: UiStorageService): StorageLike {
    return storage.sessionStorage;
  }

  protected override get listenToStorageChanges(): boolean {
    return false;
  }
}

export class LocalSync extends WebStorageSync {
  protected override resolveTarget(storage: UiStorageService): StorageLike {
    return storage.localStorage;
  }

  protected override get listenToStorageChanges(): boolean {
    return false;
  }
}

export class CrossTabSync extends WebStorageSync {
  protected override resolveTarget(storage: UiStorageService): StorageLike {
    return storage.localStorage;
  }

  protected override get listenToStorageChanges(): boolean {
    return true;
  }
}
