import { HookSlot } from "@harness/hooks";
import { ExtensibleFields, type FieldKey } from "@harness/variants";
import { shallowReactive, watchEffect } from "reactivity";
import {
  deserializeValue,
  disposeHooksSymbol,
  hydrateDerivedSymbol,
  serializeSnapshotSymbol,
  serializeValue,
  type SerializedDigestSnapshot,
} from "./internal.ts";

export class SessionDigest extends ExtensibleFields {
  readonly #derived = shallowReactive(new Map<string, unknown>());
  readonly #hooks = new Map<string, HookSlot<void, unknown>>();
  readonly #hookCleanups = new Map<string, () => void>();

  hook<TValue>(key: FieldKey<SessionDigest, TValue>): HookSlot<void, TValue | undefined> {
    let slot = this.#hooks.get(key.name) as HookSlot<void, TValue | undefined> | undefined;
    if (slot === undefined) {
      slot = new HookSlot<void, TValue | undefined>();
      this.#hooks.set(key.name, slot as HookSlot<void, unknown>);
      const stop = watchEffect(
        () => {
          const s = slot!;
          const baseValue = super.get(key);
          const computedValue = s.run(undefined, () => baseValue);
          if (computedValue === undefined || Object.is(computedValue, baseValue)) {
            if (this.#derived.has(key.name)) {
              this.#derived.delete(key.name);
            }
          } else if (!Object.is(this.#derived.get(key.name), computedValue)) {
            this.#derived.set(key.name, computedValue);
          }
        },
        { flush: "sync" },
      );
      this.#hookCleanups.set(key.name, stop);
    }
    return slot;
  }

  override get<TValue>(key: FieldKey<this, TValue>): TValue | undefined {
    if (this.#derived.has(key.name)) {
      return this.#derived.get(key.name) as TValue | undefined;
    }
    return super.get(key);
  }

  override has<TValue>(key: FieldKey<this, TValue>): boolean {
    return this.#derived.has(key.name) || super.has(key);
  }

  override set<TValue>(key: FieldKey<this, TValue>, value: TValue): this {
    this.#derived.delete(key.name);
    return super.set(key, value);
  }

  override delete<TValue>(key: FieldKey<this, TValue>): boolean {
    const hadDerived = this.#derived.delete(key.name);
    const hadBase = super.delete(key);
    return hadDerived || hadBase;
  }

  [disposeHooksSymbol](): void {
    for (const stop of this.#hookCleanups.values()) {
      stop();
    }
    this.#hookCleanups.clear();
    this.#hooks.clear();
  }

  [hydrateDerivedSymbol](raw?: Record<string, unknown>): void {
    if (!raw) return;
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) {
        this.#derived.set(k, deserializeValue(v));
      }
    }
  }

  [serializeSnapshotSymbol](): SerializedDigestSnapshot | undefined {
    const base = ExtensibleFields.serialize(this, serializeValue);
    const derived: Record<string, unknown> = {};
    for (const [k, v] of this.#derived) {
      if (v !== undefined) {
        derived[k] = serializeValue(v);
      }
    }
    const hasBase = Object.keys(base).length > 0;
    const hasDerived = Object.keys(derived).length > 0;
    if (!hasBase && !hasDerived) {
      return undefined;
    }
    return {
      ...(hasBase ? { base } : {}),
      ...(hasDerived ? { derived } : {}),
    };
  }
}
