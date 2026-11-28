import { isReactive, onScopeDispose, shallowReactive, watchSyncEffect } from "reactivity";
import type { z } from "zod";
import {
  assertActiveScope,
  connectStreamEndpoint,
  createScopedPatchSender,
  type StateSyncEndpoint,
  type StateSyncEndpointOptions,
} from "../contract.ts";
import {
  isWireEqual,
  resolveValueCodec,
  type ResolvedValueCodec,
  type SyncedCodecOptions,
} from "./codec.ts";

export interface RecordSnapshot<TWire = unknown> {
  readonly entries: Record<string, TWire>;
}

export interface RecordPatch<TWire = unknown> {
  readonly set?: Record<string, TWire>;
  readonly delete?: readonly string[];
}

export interface RecordSyncFrame<TWire = unknown> extends RecordPatch<TWire> {
  readonly type: "patch";
}

export type RecordPatchSender<TWire = unknown> = (patch: RecordPatch<TWire>) => unknown;
export type RecordSyncListener<TWire = unknown> = (frame: RecordSyncFrame<TWire>) => void;

export interface SyncedRecordClientOptions<T, TWire = unknown> extends SyncedCodecOptions<
  T,
  TWire
> {
  readonly send?: RecordPatchSender<TWire>;
}

export interface ReadonlySyncedRecordClient<T> {
  readonly items: ReadonlyMap<string, T>;
  get(key: string): T | undefined;
}

function diffRecordWires<T, TWire>(
  items: ReadonlyMap<string, T>,
  lastWires: ReadonlyMap<string, TWire>,
  serialize: (item: T) => TWire,
): { nextWires: Map<string, TWire>; patch?: RecordPatch<TWire> } {
  const nextWires = new Map<string, TWire>();
  let set: Record<string, TWire> | undefined;
  let deleted: string[] | undefined;

  for (const [key, value] of items) {
    if (value === undefined) continue;
    const wire = serialize(value);
    nextWires.set(key, wire);
    if (!lastWires.has(key) || !isWireEqual(lastWires.get(key), wire)) {
      (set ??= {})[key] = wire;
    }
  }

  for (const key of lastWires.keys()) {
    if (!nextWires.has(key)) {
      (deleted ??= []).push(key);
    }
  }

  if (set === undefined && deleted === undefined) {
    return { nextWires };
  }
  return {
    nextWires,
    patch: {
      ...(set !== undefined ? { set } : {}),
      ...(deleted !== undefined ? { delete: deleted } : {}),
    },
  };
}

export class SyncedRecordHost<T, TWire = unknown> {
  readonly items: Map<string, T>;

  readonly #codec: ResolvedValueCodec<T, TWire>;
  readonly #listeners = new Set<RecordSyncListener<TWire>>();
  #lastWires = new Map<string, TWire>();
  readonly #scope = assertActiveScope("SyncedRecordHost");

  constructor(
    items?: Map<string, T> | Iterable<readonly [string, T]>,
    options?: SyncedCodecOptions<T, TWire>,
  ) {
    this.#codec = resolveValueCodec(options);
    if (items instanceof Map) {
      this.items = isReactive(items) ? items : shallowReactive(items);
    } else {
      this.items = shallowReactive(new Map(items));
    }

    for (const [key, value] of this.items) {
      if (value !== undefined) {
        this.#lastWires.set(key, this.#codec.serialize(value));
      }
    }

    watchSyncEffect(() => {
      const { nextWires, patch } = diffRecordWires(
        this.items,
        this.#lastWires,
        this.#codec.serialize,
      );
      if (patch === undefined) return;
      this.#lastWires = nextWires;
      const frame: RecordSyncFrame<TWire> = { type: "patch", ...patch };
      for (const listener of Array.from(this.#listeners)) {
        listener(frame);
      }
    });

    onScopeDispose(() => this.#listeners.clear());
  }

  snapshot(): RecordSnapshot<TWire> {
    const entries: Record<string, TWire> = {};
    for (const [key, wire] of this.#lastWires) {
      entries[key] = wire;
    }
    return { entries };
  }

  apply(patch: RecordPatch<TWire>): void {
    if (!this.#scope.active) throw new Error("SyncedRecordHost is disposed");
    const entries = Object.entries(patch.set ?? {}).map(
      ([key, raw]) => [key, this.#codec.deserialize(raw)] as const,
    );
    if (patch.delete !== undefined) {
      for (const key of patch.delete) {
        this.items.delete(key);
      }
    }
    for (const [key, value] of entries) {
      this.items.set(key, value);
    }
  }

  subscribe(listener: RecordSyncListener<TWire>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export class SyncedRecordClient<T, TWire = unknown> implements ReadonlySyncedRecordClient<T> {
  readonly items: Map<string, T> = shallowReactive(new Map<string, T>());
  readonly #codec: ResolvedValueCodec<T, TWire>;
  #lastWires = new Map<string, TWire>();
  #applying = false;

  constructor(options?: SyncedRecordClientOptions<T, TWire>) {
    assertActiveScope("SyncedRecordClient");
    this.#codec = resolveValueCodec(options);
    const send = options?.send;
    if (send !== undefined) {
      watchSyncEffect(() => {
        const { nextWires, patch } = diffRecordWires(
          this.items,
          this.#lastWires,
          this.#codec.serialize,
        );
        if (this.#applying || patch === undefined) return;
        this.#lastWires = nextWires;
        void send(patch);
      });
    }
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  reset(snapshot: RecordSnapshot<TWire>): void {
    this.#applying = true;
    try {
      this.items.clear();
      this.#lastWires = new Map();
      for (const [key, raw] of Object.entries(snapshot.entries)) {
        this.items.set(key, this.#codec.deserialize(raw));
        this.#lastWires.set(key, raw);
      }
    } finally {
      this.#applying = false;
    }
  }

  receive(frame: RecordSyncFrame<TWire>): void {
    this.#applying = true;
    try {
      if (frame.delete !== undefined) {
        for (const key of frame.delete) {
          this.items.delete(key);
          this.#lastWires.delete(key);
        }
      }
      if (frame.set !== undefined) {
        for (const [key, raw] of Object.entries(frame.set)) {
          this.items.set(key, this.#codec.deserialize(raw));
          this.#lastWires.set(key, raw);
        }
      }
    } finally {
      this.#applying = false;
    }
  }
}

export type StateSyncRecordEndpoint<
  T extends z.ZodTypeAny,
  TReadonly extends boolean = false,
> = StateSyncEndpoint<
  TReadonly extends true ? ReadonlySyncedRecordClient<z.infer<T>> : SyncedRecordClient<z.infer<T>>,
  SyncedRecordHost<z.infer<T>, any>,
  RecordPatch<any>,
  TReadonly
> & {
  readonly kind: "record";
  readonly value: T;
};

export function recordEndpoint<T extends z.ZodTypeAny, TReadonly extends boolean = false>(
  value: T,
  options?: StateSyncEndpointOptions<TReadonly>,
): StateSyncRecordEndpoint<T, TReadonly> {
  const isReadonly = (options?.readonly ?? false) as TReadonly;
  return {
    kind: "record",
    value,
    readonly: isReadonly,
    createClient(transport, { rpcPath, streamPath }) {
      const syncClient = new SyncedRecordClient<z.infer<T>>(
        isReadonly
          ? undefined
          : {
              send: createScopedPatchSender(transport, rpcPath),
            },
      );
      connectStreamEndpoint<RecordSnapshot<any>, RecordSyncFrame<any>>(
        transport,
        streamPath,
        syncClient,
      );
      return syncClient as any;
    },
  };
}
