import { ExtensibleFields, ExtensibleVariants, type SerializedVariant } from "@harness/variants";

export const disposeHooksSymbol: unique symbol = Symbol("SessionDigest.disposeHooks");
export const hydrateDerivedSymbol: unique symbol = Symbol("SessionDigest.hydrateDerived");
export const serializeSnapshotSymbol: unique symbol = Symbol("SessionDigest.serializeSnapshot");

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof ExtensibleVariants) {
    return ExtensibleVariants.serialize(value);
  }
  if (value instanceof ExtensibleFields) {
    return ExtensibleFields.serialize(value, serializeValue);
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = serializeValue(v);
      }
    }
    return out;
  }
  return value;
}

export function deserializeValue(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return raw.map(deserializeValue);
  }
  if (!isPlainObject(raw)) {
    return raw;
  }
  const variants = raw["$variants"];
  if (
    Array.isArray(variants) &&
    variants.every((item): item is string => typeof item === "string")
  ) {
    return ExtensibleVariants.deserialize(raw as SerializedVariant);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = deserializeValue(v);
  }
  return out;
}

export interface SerializedDigestSnapshot {
  readonly base?: Record<string, unknown>;
  readonly derived?: Record<string, unknown>;
}
