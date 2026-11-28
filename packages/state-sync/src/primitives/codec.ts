import { deserializeValue, serializeValue } from "@harness/variants";

export interface SyncedCodecOptions<T, TWire = unknown> {
  readonly serialize?: (item: T) => TWire;
  readonly deserialize?: (raw: TWire) => T;
  readonly isEqual?: (a: T, b: T) => boolean;
}

export interface ResolvedValueCodec<T, TWire> {
  readonly serialize: (item: T) => TWire;
  readonly deserialize: (raw: TWire) => T;
  readonly isEqual: (a: T, b: T) => boolean;
}

export function defaultSerialize<T, TWire = unknown>(item: T): TWire {
  return serializeValue(item) as unknown as TWire;
}

export function defaultDeserialize<T, TWire = unknown>(raw: TWire): T {
  return deserializeValue(raw) as unknown as T;
}

export function resolveValueCodec<T, TWire = unknown>(
  options: SyncedCodecOptions<T, TWire> = {},
): ResolvedValueCodec<T, TWire> {
  return {
    serialize: options.serialize ?? defaultSerialize,
    deserialize: options.deserialize ?? defaultDeserialize,
    isEqual: options.isEqual ?? Object.is,
  };
}

export function isWireEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isWireEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (
        !Object.prototype.hasOwnProperty.call(b, key) ||
        !isWireEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}
