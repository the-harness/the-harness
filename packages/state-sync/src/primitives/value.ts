import {
  isRef,
  onScopeDispose,
  shallowRef,
  watchSyncEffect,
  type ComputedRef,
  type Ref,
} from "reactivity";
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

export interface ValueSnapshot<TWire = unknown> {
  readonly value: TWire;
}

export interface ValuePatch<TWire = unknown> {
  readonly value: TWire;
}

export interface ValueSyncFrame<TWire = unknown> {
  readonly type: "value";
  readonly value: TWire;
}

export type ValuePatchSender<TWire = unknown> = (patch: ValuePatch<TWire>) => unknown;
export type ValueSyncListener<TWire = unknown> = (frame: ValueSyncFrame<TWire>) => void;

export interface SyncedValueClientOptions<T, TWire = unknown> extends SyncedCodecOptions<T, TWire> {
  readonly send?: ValuePatchSender<TWire>;
}

export interface ReadonlySyncedValueClient<T> {
  readonly value: T | undefined;
}

export class SyncedValueHost<T, TWire = unknown> {
  readonly #source: Ref<T> | ComputedRef<T>;
  readonly #writable: boolean;
  readonly #codec: ResolvedValueCodec<T, TWire>;
  readonly #listeners = new Set<ValueSyncListener<TWire>>();
  #lastWire: TWire;
  readonly #scope = assertActiveScope("SyncedValueHost");

  constructor(initial: T | Ref<T> | ComputedRef<T>, options?: SyncedCodecOptions<T, TWire>) {
    this.#codec = resolveValueCodec(options);
    this.#writable = !isRef(initial);
    this.#source = this.#writable ? shallowRef(initial as T) : (initial as Ref<T> | ComputedRef<T>);
    this.#lastWire = this.#codec.serialize(this.#source.value);

    watchSyncEffect(() => {
      const nextWire = this.#codec.serialize(this.#source.value);
      if (isWireEqual(this.#lastWire, nextWire)) return;
      this.#lastWire = nextWire;
      for (const listener of Array.from(this.#listeners)) {
        listener({ type: "value", value: nextWire });
      }
    });

    onScopeDispose(() => this.#listeners.clear());
  }

  get value(): T {
    return this.#source.value;
  }

  set value(next: T) {
    if (!this.#writable) {
      throw new Error("Cannot set value on a SyncedValueHost bound to an external Ref");
    }
    (this.#source as Ref<T>).value = next;
  }

  snapshot(): ValueSnapshot<TWire> {
    return { value: this.#codec.serialize(this.#source.value) };
  }

  apply(patch: ValuePatch<TWire>): void {
    if (!this.#scope.active) throw new Error("SyncedValueHost is disposed");
    this.value = this.#codec.deserialize(patch.value);
  }

  subscribe(listener: ValueSyncListener<TWire>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export class SyncedValueClient<T, TWire = unknown> implements ReadonlySyncedValueClient<T> {
  readonly #value = shallowRef<T | undefined>(undefined);
  readonly #codec: ResolvedValueCodec<T, TWire>;
  readonly #send?: ValuePatchSender<TWire>;

  constructor(options?: SyncedValueClientOptions<T, TWire>) {
    this.#codec = resolveValueCodec(options);
    this.#send = options?.send;
  }

  get value(): T | undefined {
    return this.#value.value;
  }

  set value(next: T | undefined) {
    this.#value.value = next;
    if (this.#send !== undefined && next !== undefined) {
      void this.#send({ value: this.#codec.serialize(next) });
    }
  }

  reset(snapshot: ValueSnapshot<TWire>): void {
    this.#value.value = this.#codec.deserialize(snapshot.value);
  }

  receive(frame: ValueSyncFrame<TWire>): void {
    this.#value.value = this.#codec.deserialize(frame.value);
  }
}

export type StateSyncValueEndpoint<
  T extends z.ZodTypeAny,
  TReadonly extends boolean = false,
> = StateSyncEndpoint<
  TReadonly extends true ? ReadonlySyncedValueClient<z.infer<T>> : SyncedValueClient<z.infer<T>>,
  SyncedValueHost<z.infer<T>, any>,
  ValuePatch<any>,
  TReadonly
> & {
  readonly kind: "value";
  readonly schema: T;
};

export function valueEndpoint<T extends z.ZodTypeAny, TReadonly extends boolean = false>(
  schema: T,
  options?: StateSyncEndpointOptions<TReadonly>,
): StateSyncValueEndpoint<T, TReadonly> {
  const isReadonly = (options?.readonly ?? false) as TReadonly;
  return {
    kind: "value",
    schema,
    readonly: isReadonly,
    createClient(transport, { rpcPath, streamPath }) {
      const syncClient = new SyncedValueClient<z.infer<T>>(
        isReadonly
          ? undefined
          : {
              send: createScopedPatchSender(transport, rpcPath),
            },
      );
      connectStreamEndpoint<ValueSnapshot<any>, ValueSyncFrame<any>>(
        transport,
        streamPath,
        syncClient,
      );
      return syncClient as any;
    },
  };
}
