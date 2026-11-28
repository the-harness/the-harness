/// <reference types="vite-plus/client" />
import {
  applyWithModuleUpdate,
  canonicalClass,
  currentModuleEvaluation,
  isLiveModuleEvaluation,
  registerModuleUpdateEffect,
  relateClassVersions,
  type ModuleEvaluation,
} from "@harness/hot";
import { shallowReactive } from "reactivity";

declare const fieldOwnerBrand: unique symbol;
declare const fieldValueBrand: unique symbol;

export interface FieldKey<TOwner extends ExtensibleFields, TValue> {
  readonly name: string;
  readonly [fieldOwnerBrand]?: TOwner;
  readonly [fieldValueBrand]?: TValue;
}

export type FieldConstructor<T extends ExtensibleFields = ExtensibleFields> = new (
  initial?: Record<string, unknown> | ExtensibleFields,
) => T;

interface FieldRegistration {
  readonly key: FieldKey<any, any>;
  readonly module: string | undefined;
}

interface FieldRegistry {
  readonly fields: Map<string, FieldRegistration>;
  // The latest evaluation that defined each name, applied or not.
  readonly evaluations: Map<string, ModuleEvaluation>;
}

interface FieldsState {
  // The @harness/hot instance relating the owner classes; a full reload replaces it.
  readonly hot: typeof canonicalClass;
  readonly values: WeakMap<object, Map<string, unknown>>;
  readonly registries: WeakMap<Function, FieldRegistry>;
  // Owners that defined fields, by module and class name.
  readonly owners: Map<string, OwnerSlot>;
  readonly moduleRegistries: Map<string, Set<FieldRegistry>>;
  base: Function | undefined;
}

interface OwnerSlot {
  readonly registry: FieldRegistry;
  readonly evaluation: ModuleEvaluation;
  readonly owner: Function;
  // Several classes of that name defined fields in one evaluation.
  readonly ambiguous: boolean;
}

const STATE_KEY = "harness:fields";
// Re-evaluating this module keeps the field values and keys and relates the new base class to the
// previous one, so instances created before keep their values and pass instanceof checks.
const carried = import.meta.hot?.data[STATE_KEY] as FieldsState | undefined;
const state: FieldsState =
  carried?.hot === canonicalClass
    ? carried
    : {
        hot: canonicalClass,
        values: new WeakMap(),
        registries: new WeakMap(),
        owners: new Map(),
        moduleRegistries: new Map(),
        base: undefined,
      };
if (import.meta.hot) import.meta.hot.data[STATE_KEY] = state;

function registryOf(ctor: Function, evaluation: ModuleEvaluation | undefined): FieldRegistry {
  const owner = canonicalClass(ctor);
  let registry = state.registries.get(owner);
  if (evaluation !== undefined && ctor.name !== "") {
    // A static initializer runs before the class is related to its previous version: that version
    // is the class of the same name that defined fields in the previous evaluation of the module.
    const slot = `${evaluation.module}\0${ctor.name}`;
    const seen = state.owners.get(slot);
    const current = seen?.evaluation === evaluation;
    if (registry === undefined && seen !== undefined && !current && !seen.ambiguous) {
      registry = seen.registry;
    }
    registry ??= { fields: new Map(), evaluations: new Map() };
    const ambiguous = current && (seen.ambiguous || seen.owner !== owner);
    state.owners.set(slot, { registry, evaluation, owner, ambiguous });
  }
  registry ??= { fields: new Map(), evaluations: new Map() };
  state.registries.set(owner, registry);
  return registry;
}

function valuesOf(instance: ExtensibleFields): Map<string, unknown> {
  const values = state.values.get(instance);
  if (values === undefined) throw new TypeError("Not an ExtensibleFields instance");
  return values;
}

// An applied update releases the names its module defined before but no longer defines; values
// stored under them stay.
registerModuleUpdateEffect(STATE_KEY, (evaluation) => {
  const released: Array<readonly [FieldRegistry, string, FieldRegistration]> = [];
  for (const registry of state.moduleRegistries.get(evaluation.module) ?? []) {
    for (const [name, field] of registry.fields) {
      if (field.module === evaluation.module && registry.evaluations.get(name) !== evaluation) {
        released.push([registry, name, field]);
      }
    }
  }
  for (const [registry, name] of released) registry.fields.delete(name);
  return () => {
    for (const [registry, name, field] of released) registry.fields.set(name, field);
  };
});

export class DuplicateFieldError extends Error {
  readonly fieldName: string;

  constructor(fieldName: string) {
    super(`Duplicate field name: "${fieldName}"`);
    this.name = "DuplicateFieldError";
    this.fieldName = fieldName;
  }
}

const SCOPED_NAME_PATTERN = /^[^:]+:[^:]+:[^:]+$/;

export abstract class ExtensibleFields {
  constructor(initial?: Record<string, unknown> | ExtensibleFields) {
    const values = shallowReactive(new Map<string, unknown>());
    state.values.set(this, values);
    if (initial instanceof ExtensibleFields) {
      for (const [k, v] of valuesOf(initial)) {
        values.set(k, v);
      }
    } else if (initial !== undefined) {
      for (const [k, v] of Object.entries(initial)) {
        if (v !== undefined) {
          values.set(k, v);
        }
      }
    }
  }

  static [Symbol.hasInstance](this: Function, value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const target = canonicalClass(this);
    for (let proto = Object.getPrototypeOf(value); proto !== null; proto = Object.getPrototypeOf(proto)) {
      if (!Object.hasOwn(proto, "constructor")) continue;
      if (canonicalClass((proto as { constructor: Function }).constructor) === target) return true;
    }
    return false;
  }

  static defineField<TValue, TThis extends abstract new (...args: any[]) => ExtensibleFields>(
    this: TThis,
    name: string,
  ): FieldKey<InstanceType<TThis>, TValue> {
    if (!SCOPED_NAME_PATTERN.test(name)) {
      throw new Error(`Field name "${name}" must be scoped as "<author>:<package>:<name>"`);
    }
    const evaluation = currentModuleEvaluation();
    const registry = registryOf(this, evaluation);
    const module = evaluation?.module;
    const claim = registry.evaluations.get(name);
    if (evaluation !== undefined && claim === evaluation) throw new DuplicateFieldError(name);
    // Taken by another module's update that is not applied yet.
    if (claim !== undefined && claim.module !== module && isLiveModuleEvaluation(claim)) {
      throw new DuplicateFieldError(name);
    }
    const existing = registry.fields.get(name);
    if (existing !== undefined) {
      // The module that defined the field is being re-evaluated by a hot update.
      if (module === undefined || existing.module !== module) throw new DuplicateFieldError(name);
      registry.evaluations.set(name, evaluation!);
      return existing.key;
    }
    if (evaluation !== undefined) {
      registry.evaluations.set(name, evaluation);
      let registries = state.moduleRegistries.get(evaluation.module);
      if (registries === undefined) {
        registries = new Set();
        state.moduleRegistries.set(evaluation.module, registries);
      }
      registries.add(registry);
    }
    const key: FieldKey<InstanceType<TThis>, TValue> = Object.freeze({ name });
    const { fields, evaluations } = registry;
    applyWithModuleUpdate(() => {
      const prev = fields.get(name);
      if (prev !== undefined && prev.module !== module) throw new DuplicateFieldError(name);
      if (evaluation !== undefined) evaluations.set(name, evaluation);
      fields.set(name, { key, module });
      return () => {
        // A rejected update does not reserve the name until it is retried.
        if (evaluations.get(name) === evaluation) evaluations.delete(name);
        if (prev === undefined) fields.delete(name);
        else fields.set(name, prev);
      };
    });
    return key;
  }

  get<TValue>(key: FieldKey<this, TValue>): TValue | undefined {
    return valuesOf(this).get(key.name) as TValue | undefined;
  }

  has<TValue>(key: FieldKey<this, TValue>): boolean {
    return valuesOf(this).has(key.name);
  }

  set<TValue>(key: FieldKey<this, TValue>, value: TValue): this {
    valuesOf(this).set(key.name, value);
    return this;
  }

  delete<TValue>(key: FieldKey<this, TValue>): boolean {
    return valuesOf(this).delete(key.name);
  }

  static entries(instance: ExtensibleFields): IterableIterator<[string, unknown]> {
    return valuesOf(instance).entries();
  }

  static serialize(
    instance: ExtensibleFields,
    transformValue: (value: unknown) => unknown = (v) => v,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of valuesOf(instance)) {
      if (v !== undefined) {
        out[k] = transformValue(v);
      }
    }
    return out;
  }

  static deserialize<T extends ExtensibleFields>(
    this: FieldConstructor<T>,
    raw?: Record<string, unknown>,
    transformValue: (value: unknown) => unknown = (v) => v,
  ): T {
    if (raw === undefined) {
      return new this();
    }
    const hydrated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      hydrated[k] = transformValue(v);
    }
    return new this(hydrated);
  }
}

if (state.base !== undefined) relateClassVersions(state.base, ExtensibleFields);
state.base = ExtensibleFields;
