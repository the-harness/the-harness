import {
  isReactive,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  watchSyncEffect,
} from "reactivity";
import type { z } from "zod";
import {
  assertActiveScope,
  connectStreamEndpoint,
  createScopedPatchSender,
  type StateSyncEndpoint,
  type StateSyncEndpointOptions,
} from "../contract.ts";
import { isWireEqual } from "./codec.ts";
import {
  applyArrayOps,
  diffArray,
  resolveCodec,
  type ArrayPatch,
  type ArraySnapshot,
  type ArraySyncFrame,
  type ResolvedCodec,
  type SyncedArrayCodecOptions,
} from "./arrayDiff.ts";

export type ArrayPatchSender<TWire = unknown> = (patch: ArrayPatch<TWire>) => unknown;

export interface ReadonlySyncedArrayClient<T> {
  readonly items: readonly T[];
  readonly rev: number;
  readonly pendingCount: number;
}

export interface SyncedArrayClientOptions<T, TWire = unknown> extends SyncedArrayCodecOptions<
  T,
  TWire
> {
  readonly initialItems?: readonly T[];
  readonly send?: ArrayPatchSender<TWire>;
}

function makeCachingCodec<T, TWire>(
  codec: ResolvedCodec<T, TWire>,
  sources: readonly (readonly T[])[],
): ResolvedCodec<T, TWire> {
  return {
    ...codec,
    deserialize: (raw: TWire, id?: string): T => {
      if (id !== undefined) {
        for (const list of sources) {
          for (const candidate of list) {
            if (codec.getId(candidate) === id && isWireEqual(codec.serialize(candidate), raw)) {
              return candidate;
            }
          }
        }
      }
      const deserialized = codec.deserialize(raw, id);
      if (id === undefined) {
        const deserializedId = codec.getId(deserialized);
        for (const list of sources) {
          for (const candidate of list) {
            if (
              codec.getId(candidate) === deserializedId &&
              isWireEqual(codec.serialize(candidate), raw)
            ) {
              return candidate;
            }
          }
        }
      }
      return deserialized;
    },
  };
}

function arraysIdentical<T>(
  a: readonly T[],
  b: readonly T[],
  isEqual: (x: T, y: T) => boolean,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!isEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

function isSyncFrame<TWire>(value: unknown): value is ArraySyncFrame<TWire> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ArraySyncFrame<TWire>).rev === "number" &&
    Array.isArray((value as ArraySyncFrame<TWire>).ops)
  );
}

const bindSenderSymbol: unique symbol = Symbol("SyncedArrayClient.bindSender");

export class SyncedArrayHost<T, TWire = unknown> {
  readonly items: T[];

  readonly #codec: ResolvedCodec<T, TWire>;
  readonly #rev = shallowRef(0);
  readonly #listeners = new Set<(frame: ArraySyncFrame<TWire>) => void>();
  readonly #disconnectors = new Set<() => void>();
  #lastItems: T[];
  #applying = false;
  #disposed = false;

  constructor(
    itemsOrOptions?: T[] | SyncedArrayCodecOptions<T, TWire>,
    options?: SyncedArrayCodecOptions<T, TWire>,
  ) {
    assertActiveScope("SyncedArrayHost");
    const hasItems = Array.isArray(itemsOrOptions);
    const resolvedOptions = hasItems ? options : itemsOrOptions;
    this.#codec = resolveCodec(resolvedOptions);

    if (hasItems) {
      this.items = isReactive(itemsOrOptions) ? itemsOrOptions : shallowReactive(itemsOrOptions);
    } else {
      this.items = shallowReactive<T[]>([]);
    }

    this.#lastItems = [...this.items];

    watchSyncEffect(() => {
      const current = [...this.items];
      if (this.#applying || this.#disposed) return;
      const ops = diffArray(this.#lastItems, current, this.#codec);
      if (ops.length === 0) return;
      this.#lastItems = current;
      const nextRev = this.#rev.value + 1;
      this.#rev.value = nextRev;
      this.#emit({ rev: nextRev, ops });
    });

    onScopeDispose(() => {
      this.#dispose();
    });
  }

  get rev(): number {
    return this.#rev.value;
  }

  snapshot(): ArraySnapshot<TWire> {
    return {
      rev: this.#rev.value,
      items: this.items.map((item) => this.#codec.serialize(item)),
    };
  }

  apply(patch: ArrayPatch<TWire>): ArraySyncFrame<TWire> {
    if (this.#disposed) {
      throw new Error("SyncedArrayHost is disposed");
    }
    if (patch.ops.length === 0) {
      const frame: ArraySyncFrame<TWire> = {
        rev: this.#rev.value,
        ops: [],
        opId: patch.opId,
      };
      this.#emit(frame);
      return frame;
    }

    const codecWithCache = makeCachingCodec(this.#codec, [this.#lastItems]);
    const next = applyArrayOps(this.#lastItems, patch.ops, codecWithCache);
    const ops = diffArray(this.#lastItems, next, this.#codec);

    if (ops.length === 0) {
      const frame: ArraySyncFrame<TWire> = {
        rev: this.#rev.value,
        ops: [],
        opId: patch.opId,
      };
      this.#emit(frame);
      return frame;
    }

    this.#applying = true;
    try {
      this.#lastItems = next;
      this.items.splice(0, this.items.length, ...next);
    } finally {
      this.#applying = false;
    }

    const nextRev = this.#rev.value + 1;
    this.#rev.value = nextRev;
    const frame: ArraySyncFrame<TWire> = {
      rev: nextRev,
      ops,
      opId: patch.opId,
    };
    this.#emit(frame);
    return frame;
  }

  subscribe(listener: (frame: ArraySyncFrame<TWire>) => void): () => void {
    if (this.#disposed) {
      return () => {};
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  connect(client: SyncedArrayClient<T, TWire>): () => void {
    if (this.#disposed) {
      return () => {};
    }
    client.reset(this.snapshot());
    const unsubscribe = this.subscribe((frame) => {
      client.receive(frame);
    });
    const unbindSender = client[bindSenderSymbol]((patch) => {
      return this.apply(patch);
    });
    let active = true;
    const disconnect = () => {
      if (!active) return;
      active = false;
      this.#disconnectors.delete(disconnect);
      unsubscribe();
      unbindSender();
    };
    this.#disconnectors.add(disconnect);
    return disconnect;
  }

  #dispose(): void {
    this.#disposed = true;
    for (const disconnect of Array.from(this.#disconnectors)) {
      disconnect();
    }
    this.#listeners.clear();
  }

  #emit(frame: ArraySyncFrame<TWire>): void {
    for (const listener of Array.from(this.#listeners)) {
      listener(frame);
    }
  }
}

export class SyncedArrayClient<T, TWire = unknown> {
  readonly items: T[];

  readonly #codec: ResolvedCodec<T, TWire>;
  readonly #rev = shallowRef(0);
  readonly #pendingCount = shallowRef(0);
  readonly #inflight: ArrayPatch<TWire>[] = [];
  #serverItems: T[];
  #expectedView: T[];
  #send: ArrayPatchSender<TWire> | undefined;
  #reconciling = false;
  #disposed = false;

  constructor(options: SyncedArrayClientOptions<T, TWire> = {}) {
    assertActiveScope("SyncedArrayClient");
    this.#codec = resolveCodec(options);
    this.#send = options.send;
    const initial = options.initialItems ? [...options.initialItems] : [];
    this.items = shallowReactive<T[]>([...initial]);
    this.#serverItems = [...initial];
    this.#expectedView = [...initial];

    watchSyncEffect(() => {
      const current = [...this.items];
      if (this.#reconciling || this.#disposed) return;
      const ops = diffArray(this.#expectedView, current, this.#codec);
      if (ops.length === 0) return;

      this.#expectedView = current;
      const patch: ArrayPatch<TWire> = {
        opId: crypto.randomUUID(),
        ops,
      };
      this.#inflight.push(patch);
      this.#pendingCount.value = this.#inflight.length;
      this.#dispatchPatch(patch);
    });

    onScopeDispose(() => {
      this.#disposed = true;
      this.#inflight.length = 0;
      this.#pendingCount.value = 0;
    });
  }

  get rev(): number {
    return this.#rev.value;
  }

  get pendingCount(): number {
    return this.#pendingCount.value;
  }

  reset(snapshot: ArraySnapshot<TWire>): void {
    if (this.#disposed) return;
    const codecWithCache = makeCachingCodec(this.#codec, [this.items, this.#serverItems]);
    this.#rev.value = snapshot.rev;
    this.#serverItems = snapshot.items.map((raw) => codecWithCache.deserialize(raw));
    this.#reconcile();
  }

  receive(frame: ArraySyncFrame<TWire>): void {
    if (this.#disposed) return;
    const removedInflight = frame.opId !== undefined ? this.#removeInflight(frame.opId) : false;

    if (frame.rev <= this.#rev.value) {
      if (removedInflight) {
        this.#reconcile();
      }
      return;
    }

    if (frame.ops.length > 0) {
      const codecWithCache = makeCachingCodec(this.#codec, [this.items, this.#serverItems]);
      this.#serverItems = applyArrayOps(this.#serverItems, frame.ops, codecWithCache);
    }
    this.#rev.value = frame.rev;
    this.#reconcile();
  }

  [bindSenderSymbol](sender: ArrayPatchSender<TWire>): () => void {
    this.#send = sender;
    for (const patch of Array.from(this.#inflight)) {
      this.#dispatchPatch(patch);
    }
    return () => {
      if (this.#send === sender) {
        this.#send = undefined;
      }
    };
  }

  #dispatchPatch(patch: ArrayPatch<TWire>): void {
    const send = this.#send;
    if (send === undefined) {
      return;
    }
    try {
      const result = send(patch);
      if (isSyncFrame<TWire>(result)) {
        this.receive(result);
      } else if (result !== null && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).then(
          (resolved) => {
            if (isSyncFrame<TWire>(resolved)) {
              this.receive(resolved);
            }
          },
          () => {
            if (this.#removeInflight(patch.opId)) {
              this.#reconcile();
            }
          },
        );
      }
    } catch {
      if (this.#removeInflight(patch.opId)) {
        this.#reconcile();
      }
    }
  }

  #removeInflight(opId: string): boolean {
    const idx = this.#inflight.findIndex((entry) => entry.opId === opId);
    if (idx === -1) return false;
    this.#inflight.splice(idx, 1);
    this.#pendingCount.value = this.#inflight.length;
    return true;
  }

  #reconcile(): void {
    const codecWithCache = makeCachingCodec(this.#codec, [this.items, this.#serverItems]);
    let nextView = [...this.#serverItems];
    for (const patch of this.#inflight) {
      nextView = applyArrayOps(nextView, patch.ops, codecWithCache);
    }
    this.#expectedView = [...nextView];
    if (arraysIdentical(this.items, nextView, this.#codec.isEqual)) {
      return;
    }
    this.#reconciling = true;
    try {
      this.items.splice(0, this.items.length, ...nextView);
    } finally {
      this.#reconciling = false;
    }
  }
}

export interface StateSyncArrayEndpointOptions<
  T,
  TReadonly extends boolean = false,
> extends StateSyncEndpointOptions<TReadonly> {
  readonly initialItems?: readonly T[];
}

export type StateSyncArrayEndpoint<
  T extends z.ZodTypeAny,
  TReadonly extends boolean = false,
> = StateSyncEndpoint<
  TReadonly extends true ? ReadonlySyncedArrayClient<z.infer<T>> : SyncedArrayClient<z.infer<T>>,
  SyncedArrayHost<z.infer<T>, any>,
  ArrayPatch<any>,
  TReadonly
> & {
  readonly kind: "array";
  readonly item: T;
};

export function arrayEndpoint<T extends z.ZodTypeAny, TReadonly extends boolean = false>(
  item: T,
  options?: StateSyncArrayEndpointOptions<z.infer<T>, TReadonly>,
): StateSyncArrayEndpoint<T, TReadonly> {
  const isReadonly = (options?.readonly ?? false) as TReadonly;
  return {
    kind: "array",
    item,
    readonly: isReadonly,
    createClient(transport, { rpcPath, streamPath }) {
      const syncClient = new SyncedArrayClient<z.infer<T>>({
        initialItems: options?.initialItems,
        send: isReadonly ? undefined : createScopedPatchSender(transport, rpcPath),
      });
      connectStreamEndpoint<ArraySnapshot<any>, ArraySyncFrame<any>>(
        transport,
        streamPath,
        syncClient,
      );
      return syncClient as any;
    },
  };
}
