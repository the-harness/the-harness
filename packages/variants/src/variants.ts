/// <reference types="vite-plus/client" />
import {
  applyWithModuleUpdate,
  canonicalClass,
  currentModuleEvaluation,
  isLiveModuleEvaluation,
  latestClass,
  registerClassVersion,
  registerModuleUpdateEffect,
  relateClassVersions,
  type ModuleEvaluation,
} from "@harness/hot";
import { z } from "zod";
import { ExtensibleFields, type FieldConstructor } from "./fields.ts";

declare const defaultsBrand: unique symbol;

export type VariantProps<TInstance> = TInstance extends {
  readonly [defaultsBrand]?: infer TDefaults;
}
  ? {
      readonly [
        K in keyof TInstance as K extends typeof defaultsBrand | keyof TDefaults
          ? never
          : TInstance[K] extends (...args: any[]) => any
            ? never
            : K
      ]: TInstance[K];
    } & {
      readonly [K in keyof TDefaults]?: TDefaults[K];
    }
  : {
      readonly [
        K in keyof TInstance as TInstance[K] extends (...args: any[]) => any ? never : K
      ]: TInstance[K];
    };

export type VariantConstructor<T extends ExtensibleVariants<any> = ExtensibleVariants<any>> =
  abstract new (...args: any[]) => T;

export interface SerializedVariant {
  readonly $variants: readonly string[];
  readonly [key: string]: unknown;
}

interface VariantRegistry {
  // The @harness/hot instance relating the registered classes; a full reload replaces it.
  readonly hot: typeof canonicalClass;
  readonly nameToCtor: Map<string, new (props?: Record<string, unknown>) => ExtensibleVariants>;
  readonly ctorToName: WeakMap<Function, string>;
  readonly nameToModule: Map<string, string | undefined>;
  // The latest evaluation that registered each name and its class, applied or not.
  readonly nameToClaim: Map<string, VariantClaim>;
  base: Function | undefined;
}

interface VariantClaim {
  readonly evaluation: ModuleEvaluation;
  readonly ctor: new (props?: Record<string, unknown>) => ExtensibleVariants;
}

const REGISTRY_KEY = "harness:variants";
// Re-evaluating this module keeps the registered classes and relates the new base class to the
// previous one, so values created before still serialize and pass instanceof checks.
const carried = import.meta.hot?.data[REGISTRY_KEY] as VariantRegistry | undefined;
const registry: VariantRegistry =
  carried?.hot === canonicalClass
    ? carried
    : {
        hot: canonicalClass,
        nameToCtor: new Map(),
        ctorToName: new WeakMap(),
        nameToModule: new Map(),
        nameToClaim: new Map(),
        base: undefined,
      };
if (import.meta.hot) import.meta.hot.data[REGISTRY_KEY] = registry;
const { nameToCtor, ctorToName, nameToModule, nameToClaim } = registry;

// An applied update releases the names its module registered before but no longer registers.
// Values created before keep serializing under the name; serialized data falls back along its
// chain until another class claims the name.
registerModuleUpdateEffect(REGISTRY_KEY, (evaluation) => {
  const released = [...nameToModule]
    .filter(
      ([name, module]) =>
        module === evaluation.module && nameToClaim.get(name)?.evaluation !== evaluation,
    )
    .map(([name]) => [name, nameToCtor.get(name)!] as const);
  for (const [name] of released) {
    nameToCtor.delete(name);
    nameToModule.delete(name);
  }
  return () => {
    for (const [name, ctor] of released) {
      nameToCtor.set(name, ctor);
      nameToModule.set(name, evaluation.module);
    }
  };
});

export class DuplicateVariantError extends Error {
  readonly variantName: string;

  constructor(variantName: string) {
    super(`Duplicate variant name: "${variantName}"`);
    this.name = "DuplicateVariantError";
    this.variantName = variantName;
  }
}

const SCOPED_NAME_PATTERN = /^[^:]+(?::[^:]+){2,}$/;

export function variant<Ctor extends VariantConstructor>(name: string): (target: Ctor) => void {
  if (!SCOPED_NAME_PATTERN.test(name)) {
    throw new Error(`Variant name "${name}" must be scoped as "<author>:<package>:<name>"`);
  }
  return (target) => {
    const existing = nameToCtor.get(name);
    const evaluation = currentModuleEvaluation();
    const module = evaluation?.module;
    const claim = nameToClaim.get(name);
    if (evaluation !== undefined && claim?.evaluation === evaluation) {
      throw new DuplicateVariantError(name);
    }
    // Taken by another module's update that is not applied yet.
    if (
      claim !== undefined &&
      claim.evaluation.module !== module &&
      isLiveModuleEvaluation(claim.evaluation)
    ) {
      throw new DuplicateVariantError(name);
    }
    if (existing !== undefined && existing !== (target as unknown)) {
      // The module that registered the name is being re-evaluated by a hot update.
      if (module === undefined || nameToModule.get(name) !== module) {
        throw new DuplicateVariantError(name);
      }
      relateClassVersions(existing, target);
    }
    const ctor = target as unknown as new (props?: Record<string, unknown>) => ExtensibleVariants;
    const claimed = evaluation === undefined ? undefined : { evaluation, ctor };
    if (claimed !== undefined) nameToClaim.set(name, claimed);
    ctorToName.set(target, name);
    applyWithModuleUpdate(() => {
      const prevCtor = nameToCtor.get(name);
      const prevModule = nameToModule.get(name);
      if (prevCtor !== undefined && prevModule !== module) throw new DuplicateVariantError(name);
      if (claimed !== undefined) nameToClaim.set(name, claimed);
      const prevLatest = existing === undefined ? undefined : latestClass(existing);
      if (existing !== undefined) registerClassVersion(existing, target);
      nameToModule.set(name, module);
      nameToCtor.set(name, ctor);
      return () => {
        // A rejected update neither shows nor reserves the name until it is retried.
        if (nameToClaim.get(name) === claimed) nameToClaim.delete(name);
        if (prevLatest !== undefined) registerClassVersion(target, prevLatest);
        if (prevCtor === undefined) {
          nameToCtor.delete(name);
          nameToModule.delete(name);
        } else {
          nameToCtor.set(name, prevCtor);
          nameToModule.set(name, prevModule);
        }
      };
    });
  };
}

// Module code also sees the classes staged by the latest evaluation of each module that did not
// throw, e.g. its own or those of modules evaluated before it in the same update; other code only
// sees applied ones.
function registeredClass(
  name: string,
): (new (props?: Record<string, unknown>) => ExtensibleVariants) | undefined {
  const applied = nameToCtor.get(name);
  const claim = nameToClaim.get(name);
  if (
    claim !== undefined &&
    claim.ctor !== applied &&
    currentModuleEvaluation() !== undefined &&
    isLiveModuleEvaluation(claim.evaluation)
  ) {
    return claim.ctor;
  }
  return applied === undefined ? undefined : latestClass(applied);
}

function getVariantChain(instance: ExtensibleVariants): string[] {
  const chain: string[] = [];
  let current: unknown = instance.constructor;
  while (
    typeof current === "function" &&
    current !== ExtensibleVariants &&
    current !== Function.prototype
  ) {
    const name = ctorToName.get(current);
    if (name !== undefined) {
      chain.unshift(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return chain;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof ExtensibleVariants) {
    const chain = getVariantChain(value);
    if (chain.length === 0) {
      throw new Error(
        `Variant class "${value.constructor.name || "<anonymous>"}" is not registered with @variant()`,
      );
    }
    const out: Record<string, unknown> = { $variants: chain };
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof ExtensibleFields) {
        const serializedFields = ExtensibleFields.serialize(v, serializeValue);
        if (Object.keys(serializedFields).length > 0) {
          out[k] = serializedFields;
        }
      } else if (v !== undefined) {
        out[k] = serializeValue(v);
      }
    }
    return out as SerializedVariant;
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
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "$variants") continue;
      props[k] = deserializeValue(v);
    }
    for (let i = variants.length - 1; i >= 0; i--) {
      const Ctor = registeredClass(variants[i]!);
      if (Ctor !== undefined) {
        return applyVariantProps(new Ctor(), props);
      }
    }
    throw new Error(`Unknown variant chain: ${variants.join(" -> ")}`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = deserializeValue(v);
  }
  return out;
}

function applyVariantProps<T extends ExtensibleVariants>(
  instance: T,
  props?: Record<string, unknown>,
): T {
  if (props !== undefined) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      const current = (instance as Record<string, unknown>)[key];
      if (current instanceof ExtensibleFields && isPlainObject(value)) {
        const FieldCtor = current.constructor as FieldConstructor & {
          deserialize(
            raw: Record<string, unknown>,
            transformValue: (value: unknown) => unknown,
          ): ExtensibleFields;
        };
        (instance as Record<string, unknown>)[key] = FieldCtor.deserialize(value, deserializeValue);
      } else {
        (instance as Record<string, unknown>)[key] = value;
      }
    }
  }
  return instance;
}

export abstract class ExtensibleVariants<TDefaults extends object = {}> {
  declare readonly [defaultsBrand]?: TDefaults;

  constructor(props?: Record<string, unknown>) {
    applyVariantProps(this, props);
  }

  // A hot update re-defines variant classes; values created from any version of a class, or from
  // a class registered under the same variant name, are instances of every version.
  static [Symbol.hasInstance](this: Function, value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const target = canonicalClass(this);
    const name = ctorToName.get(this);
    for (let proto = Object.getPrototypeOf(value); proto !== null; proto = Object.getPrototypeOf(proto)) {
      if (!Object.hasOwn(proto, "constructor")) continue;
      const ctor = (proto as { constructor: Function }).constructor;
      if (canonicalClass(ctor) === target) return true;
      if (name !== undefined && ctorToName.get(ctor) === name) return true;
    }
    return false;
  }

  static create<T extends ExtensibleVariants<any>>(
    this: new (props?: any) => T,
    ...args: keyof VariantProps<T> extends never
      ? [props?: VariantProps<T>]
      : {} extends VariantProps<T>
        ? [props?: VariantProps<T>]
        : [props: VariantProps<T>]
  ): T {
    return applyVariantProps(
      new (latestClass(this))(),
      args[0] as Record<string, unknown> | undefined,
    );
  }

  static get schema(): z.ZodType<ExtensibleVariants> {
    return z.custom<ExtensibleVariants>((val) => val instanceof this, {
      message: `Expected instance of ${this.name || "ExtensibleVariants"}`,
    });
  }

  static getVariantChain(instance: ExtensibleVariants): readonly string[] {
    return getVariantChain(instance);
  }

  static serialize(instance: ExtensibleVariants): SerializedVariant {
    return serializeValue(instance) as SerializedVariant;
  }

  static deserialize<T extends ExtensibleVariants = ExtensibleVariants>(
    this: VariantConstructor<T>,
    raw: SerializedVariant,
  ): T {
    const value = deserializeValue(raw);
    if (!(value instanceof this)) {
      throw new TypeError(
        `Deserialized value is not an instance of ${this.name || "expected variant base"}`,
      );
    }
    return value;
  }
}

if (registry.base !== undefined) relateClassVersions(registry.base, ExtensibleVariants);
registry.base = ExtensibleVariants;
