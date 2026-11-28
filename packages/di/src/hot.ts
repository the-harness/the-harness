import {
  beginModuleEvaluation,
  endModuleEvaluation,
  latestClass,
  registerClassVersion,
  relateClassVersions,
  takeModuleUpdateEffects,
} from "@harness/hot";
import { shallowRef, type ShallowRef } from "reactivity";
import { getOrCreate } from "./collections.ts";
import { isSamePlainData, type ServiceConstructor } from "./descriptors.ts";
import {
  batchScopeUpdates,
  beginScopeTransaction,
  commitScopeTransaction,
  replaceService,
  rollbackScopeTransaction,
} from "./scope.ts";

export interface HotContext {
  readonly data: Record<string, unknown>;
  on(
    event: "vite:beforeUpdate" | "vite:afterUpdate" | "vite:beforePrune",
    listener: (payload: object) => void,
  ): void;
  send(event: "harness:hmr-rebind", data: Rebind): void;
  send(event: "harness:hmr-settled", data: Settled): void;
}

// Modules to re-evaluate, and the exports reached by replaced classes or changed bindings
// (through barrels too), for the server to add importers that recorded no dependency.
export interface Rebind {
  readonly ids: readonly string[];
  readonly replaced: Readonly<Record<string, readonly string[]>>;
  readonly changed: Readonly<Record<string, readonly string[]>>;
  readonly instrumented: readonly string[];
  // Per reached module, the instrumented modules that recorded their dependency on it.
  readonly recorded: Readonly<Record<string, readonly string[]>>;
}

// An update the runner finished: its timestamp and the modules it re-imported.
export interface Settled {
  readonly timestamp: number;
  readonly urls: readonly string[];
}

export interface HotModule {
  fn<F extends Function>(local: string, impl: F): F;
  value(exported: string, value: unknown, isClass?: boolean): void;
  data<T>(local: string, value: T): T;
  class<T>(local: string, value: T): T;
  unit<T>(local: string, value: T): T;
  deps(
    dependencies: Readonly<Record<string, readonly string[]>>,
    reexports?: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>>,
  ): void;
  commit(): void;
}

interface Forwarder {
  readonly fn: Function;
  readonly local: string;
  impl: Function;
}

interface HotRecord {
  readonly runtime: object;
  readonly id: string;
  readonly version: ShallowRef<number>;
  readonly forwarders: Map<string, Forwarder>;
  // Latest evaluated class per top-level binding, for identity.
  readonly classes: Map<string, Function>;
  // Applied state.
  appliedClasses: Map<string, Function>;
  values: Map<string, unknown>;
  classExports: ReadonlySet<string>;
  // Applied values of exported plain-data declarations, by local.
  data: Map<string, unknown>;
  // Setup units by local; the first one created stays.
  readonly units: Map<string, unknown>;
  // Implementations of the evaluation in progress, which its own top-level code calls.
  staged: Map<Forwarder, Function> | undefined;
  signature: string;
  // The update of the latest evaluation.
  cycle: number;
}

interface StagedUpdate {
  readonly hot: HotContext;
  readonly impls: Map<Forwarder, Function>;
  readonly values: Map<string, unknown>;
  readonly classExports: ReadonlySet<string>;
  readonly data: Map<string, unknown>;
  readonly classes: Map<string, Function>;
  // The update the evaluation belonged to; evaluations outside updates each get their own.
  readonly cycle: number;
  // Evaluation order, across modules.
  readonly seq: number;
  // Not the module's first evaluation in this update.
  readonly repeated: boolean;
  // The module's URL in Vite's update payloads.
  readonly url: string | undefined;
  readonly signature: string;
  readonly effects: Array<() => () => void>;
  // Importers were already re-bound to this evaluation's changed exports.
  rebound: boolean;
}

type ClassPair = readonly [ServiceConstructor<unknown>, ServiceConstructor<unknown>];

const RECORD_KEY = "harness:di-hmr";
// A full reload re-evaluates this module too; records left in hot.data by the previous module
// graph belong to another reactivity/DI instance and must not be reused.
const runtime = {};
// Updates evaluated but not yet applied. A failed batch stays here and is retried together with
// the next one, so the applied state is always either the last applied or the latest versions.
const pending = new Map<HotRecord, StagedUpdate>();
// Instrumented modules Vite is updating in the current update, and those that committed.
// Instrumented modules whose latest evaluation started but did not commit: batches wait for them,
// whichever later update brings them. (The runner may skip modules an update lists, so the
// update payload does not tell which modules failed.)
const waitingUrls = new Set<string>();
const stagedRecords = new Set<HotRecord>();
// Instrumented module evaluations in progress; staged implementations are visible only to code
// they run, not to callers between evaluations (e.g. request handlers while a batch is pending).
let activeEvaluations = 0;
let cycles = 0;
let evaluations = 0;
let currentCycle = 0;
// Vite notifies every module's listener with the same payload; a batch is applied once.
let currentUpdate: object | undefined;
let appliedUpdate: object | undefined;
let channel: HotContext | undefined;

function onBeforeUpdate(payload: object): void {
  if (currentUpdate === payload) return;
  currentUpdate = payload;
  currentCycle = ++cycles;
  // The runner re-imports the accepting module of each update (`path` is only the changed module).
  // One about to be evaluated again supersedes its unapplied update, even when the new evaluation
  // fails before reaching its body (e.g. in one of its imports).
  const updated = new Set(
    ((payload as { updates?: Array<{ acceptedPath?: string }> }).updates ?? []).map(
      (update) => update.acceptedPath,
    ),
  );
  for (const [record, update] of pending) {
    if (update.url !== undefined && updated.has(update.url)) pending.delete(record);
  }
}

function clearStaged(): void {
  for (const record of stagedRecords) record.staged = undefined;
  stagedRecords.clear();
}

// A module removed from the graph is no longer waited for.
function onBeforePrune(payload: object): void {
  for (const path of (payload as { paths?: readonly string[] }).paths ?? []) waitingUrls.delete(path);
}

function onAfterUpdate(payload: object): void {
  if (appliedUpdate === payload) return;
  appliedUpdate = payload;
  currentUpdate = undefined;
  clearStaged();
  // Before re-binding, whose evaluations would otherwise evaluate unchanged imports again.
  const updates =
    (payload as { updates?: Array<{ timestamp: number; path: string; acceptedPath: string }> }).updates ?? [];
  if (updates.length > 0) {
    channel?.send("harness:hmr-settled", {
      timestamp: updates[0]!.timestamp,
      urls: [...new Set(updates.flatMap((update) => [update.path, update.acceptedPath]))],
    });
  }
  // A module of the batch that failed to evaluate would leave the batch half applied: it stays
  // pending until that module evaluates again.
  if (waitingUrls.size > 0) {
    if (pending.size > 0) {
      console.error(`[hmr] update withheld until ${[...waitingUrls].join(", ")} evaluate again`);
    }
    return;
  }
  applyPending();
}

type ReexportNames = ReadonlyArray<readonly [from: string, to: string]>;

// Edges from each module to the modules it refers to, replaced as a whole on every evaluation and
// looked up from the target.
class Edges<V> {
  readonly #targets = new Map<string, readonly string[]>();
  readonly #sources = new Map<string, Map<string, V>>();

  set(source: string, edges: Readonly<Record<string, V>>): void {
    for (const target of this.#targets.get(source) ?? []) this.#sources.get(target)?.delete(source);
    this.#targets.set(source, Object.keys(edges));
    for (const [target, value] of Object.entries(edges)) {
      getOrCreate(this.#sources, target, () => new Map()).set(source, value);
    }
  }

  into(target: string): ReadonlyMap<string, V> {
    return this.#sources.get(target) ?? new Map();
  }

  sources(): string[] {
    return [...this.#targets.keys()];
  }
}

// Module -> its imports -> the names it uses other than as DI identities.
const dependencies = new Edges<ReadonlySet<string>>();
// Barrel -> modules whose names it exports again -> [name there, name exported] ("*" for all).
const reexports = new Edges<ReexportNames>();

// Wrapped in place, an initializer loses the name it would take from its binding.
function named<T>(local: string, value: T): T {
  // An anonymous default declaration carries the transform's binding name.
  const unnamed = (name: string) => name === "" || (local === "default" && name === "__harness_default");
  if (typeof value === "function" && unnamed(value.name)) {
    Object.defineProperty(value, "name", { value: local, configurable: true });
  }
  return value;
}

const passthrough: HotModule = {
  fn: (local, impl) => named(local, impl),
  value: () => {},
  class: (local, value) => named(local, value),
  data: (_local, value) => value,
  unit: (_local, value) => value,
  deps: () => {},
  commit: () => {},
};

export function createHotModule(
  hot: HotContext | undefined,
  id: string,
  signature: string,
): HotModule {
  if (hot === undefined) return passthrough;
  const prev = hot.data[RECORD_KEY] as HotRecord | undefined;
  const record: HotRecord =
    prev !== undefined && prev.runtime === runtime
      ? prev
      : {
          runtime,
          id,
          version: shallowRef(0),
          forwarders: new Map(),
          classes: new Map(),
          appliedClasses: new Map(),
          values: new Map(),
          classExports: new Set(),
          data: new Map(),
          units: new Map(),
          staged: undefined,
          signature,
          cycle: -1,
        };
  const isUpdate = record === prev;
  channel = hot;
  const url = (hot as { readonly ownerPath?: string }).ownerPath;
  if (url !== undefined) {
    waitingUrls.add(url);
  }
  const cycle = currentUpdate !== undefined ? currentCycle : ++cycles;
  const seq = ++evaluations;
  // Vite may invalidate a module again while the runner is still in an update, e.g. for a second
  // edit (in an import cycle); importers evaluated in between hold the earlier evaluation.
  const repeated = record.cycle === cycle;
  record.cycle = cycle;
  // Staged on a first evaluation too, so one that throws leaves no registrations behind.
  beginModuleEvaluation(id, true);
  hot.data[RECORD_KEY] = record;
  hot.on("vite:beforeUpdate", onBeforeUpdate);
  hot.on("vite:afterUpdate", onAfterUpdate);
  hot.on("vite:beforePrune", onBeforePrune);
  // This evaluation supersedes an unapplied one; if it throws, the applied version stays.
  if (isUpdate) pending.delete(record);
  const impls = new Map<Forwarder, Function>();
  activeEvaluations++;
  let evaluating = true;
  const endEvaluation = (): void => {
    if (!evaluating) return;
    evaluating = false;
    activeEvaluations--;
  };
  // A module body has no top-level await: this runs once it finished or threw.
  queueMicrotask(endEvaluation);
  if (isUpdate) {
    record.staged = impls;
    stagedRecords.add(record);
    // Outside an update, only the module's own top-level code runs before it commits.
    if (currentUpdate === undefined) queueMicrotask(clearStaged);
  }
  const data = new Map<string, unknown>();
  const values = new Map<string, unknown>();
  const classExports = new Set<string>();
  const classes = new Map<string, Function>();
  return {
    fn(local, impl) {
      named(local, impl);
      let forwarder = record.forwarders.get(local);
      if (forwarder === undefined) {
        forwarder = createForwarder(record, impl, local);
        record.forwarders.set(local, forwarder);
      }
      impls.set(forwarder, impl);
      return forwarder.fn as typeof impl;
    },
    value(exported, value, isClass) {
      values.set(exported, value);
      if (isClass) classExports.add(exported);
    },
    data(local, value) {
      // Recreated on every evaluation: an equal value keeps the applied object, so its identity
      // stays the same for the module's new code and for importers.
      const applied = record.data.get(local);
      const result = isUpdate && record.data.has(local) && isSamePlainData(applied, value) ? applied : value;
      data.set(local, result);
      return result as typeof value;
    },
    unit(local, value) {
      if (!record.units.has(local)) record.units.set(local, value);
      return record.units.get(local) as typeof value;
    },
    class(local, next) {
      if (typeof next !== "function") return next;
      named(local, next);
      // A top-level class binding of a module is one class across versions, whether or not the
      // update is applied; only which version gets constructed follows the applied state.
      const prev = record.classes.get(local);
      if (prev !== undefined) relateClassVersions(prev, next);
      record.classes.set(local, next);
      classes.set(local, next);
      return next;
    },
    deps(next, names = {}) {
      dependencies.set(id, Object.fromEntries(Object.entries(next).map(([source, used]) => [source, new Set(used)])));
      reexports.set(id, names);
    },
    commit() {
      endEvaluation();
      endModuleEvaluation(id);
      if (url !== undefined) waitingUrls.delete(url);
      const effects = takeModuleUpdateEffects(id);
      if (!isUpdate) {
        for (const [forwarder, impl] of impls) setImpl(forwarder, impl);
        record.values = values;
        record.classExports = classExports;
        record.data = data;
        record.appliedClasses = classes;
        for (const effect of effects) effect();
        return;
      }
      pending.set(record, {
        hot,
        impls,
        values,
        classExports,
        data,
        classes,
        cycle,
        seq,
        repeated,
        url,
        signature,
        effects,
        rebound: false,
      });
      // Outside an update (e.g. an importer re-evaluated by a later import) nothing else would
      // apply it; inside one, vite:afterUpdate applies the whole batch.
      if (currentUpdate === undefined && waitingUrls.size === 0) applyPending();
    },
  };
}

const GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {});
const AsyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {});

// The forwarder has the shape of its implementation: constructible with a prototype for plain
// functions, a generator for generators, and neither for arrows, methods and async functions.
function createForwarder(record: HotRecord, impl: Function, local: string): Forwarder {
  const current = (): Function => {
    void record.version.value;
    return (activeEvaluations > 0 ? record.staged?.get(forwarder) : undefined) ?? forwarder.impl;
  };
  const kind = Object.getPrototypeOf(impl);
  const fn =
    kind === GeneratorFunctionPrototype
      ? {
          *f(this: unknown, ...args: unknown[]): Generator<unknown, unknown, unknown> {
            return yield* Reflect.apply(current(), this, args);
          },
        }.f
      : kind === AsyncGeneratorFunctionPrototype
        ? {
            async *f(this: unknown, ...args: unknown[]): AsyncGenerator<unknown, unknown, unknown> {
              return yield* Reflect.apply(current(), this, args);
            },
          }.f
        : Object.hasOwn(impl, "prototype")
          ? function (this: unknown, ...args: unknown[]): unknown {
              return new.target === undefined
                ? Reflect.apply(current(), this, args)
                : Reflect.construct(current(), args, new.target);
            }
          : {
              f(this: unknown, ...args: unknown[]): unknown {
                return Reflect.apply(current(), this, args);
              },
            }.f;
  const forwarder: Forwarder = { impl, fn, local };
  setImpl(forwarder, impl);
  return forwarder;
}

// Follows the implementation: kind (async), name, length and, for constructors, the prototype that
// instances created through the implementation's own name inherit from.
function setImpl(forwarder: Forwarder, impl: Function): void {
  const { fn } = forwarder;
  forwarder.impl = impl;
  Object.setPrototypeOf(fn, Object.getPrototypeOf(impl));
  // Wrapped in place, a function variable's initializer has no inferred name.
  Object.defineProperty(fn, "name", { value: impl.name || forwarder.local, configurable: true });
  Object.defineProperty(fn, "length", { value: impl.length, configurable: true });
  if (Object.hasOwn(fn, "prototype") && Object.hasOwn(impl, "prototype") && !isGenerator(impl)) {
    fn.prototype = impl.prototype;
    // Module code names the forwarder, so instances report it as their constructor too.
    const constructor = Object.getOwnPropertyDescriptor(impl.prototype, "constructor");
    if (constructor?.value === impl && constructor.writable) impl.prototype.constructor = fn;
  }
}

function isGenerator(fn: Function): boolean {
  const kind = Object.getPrototypeOf(fn);
  return kind === GeneratorFunctionPrototype || kind === AsyncGeneratorFunctionPrototype;
}

// Every export of a module, e.g. when its `export *` sources changed.
const ALL = "*";

function reexportedNames(mapping: ReexportNames, names: readonly string[]): Set<string> {
  const all = names.includes(ALL);
  const exported = new Set<string>();
  for (const [from, to] of mapping) {
    if (from === "*" && to === "*") for (const name of names) exported.add(name);
    else if (from === "*") exported.add(to);
    else if (all || names.includes(from)) exported.add(to);
  }
  return exported;
}

// Export names whose signature entry differs, e.g. an alias pointing to another local.
function changedExportNames(prev: string, next: string): Set<string> {
  // `export *` entries all start with "*": they are keyed by the whole entry (their source).
  const entries = (signature: string) =>
    new Map(
      signature
        .split("|")
        .filter(Boolean)
        .map((entry) => {
          const name = entry.slice(0, entry.indexOf("="));
          return [name === "*" ? entry : name, entry] as const;
        }),
    );
  const before = entries(prev);
  const after = entries(next);
  const changed = new Set<string>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) !== after.get(name)) changed.add(name);
  }
  return changed;
}

// An evaluation's position: its update, then its order within it.
interface Order {
  readonly cycle: number;
  readonly seq: number;
}

const precedes = (a: Order, b: Order): boolean => a.cycle < b.cycle || (a.cycle === b.cycle && a.seq < b.seq);

type Changes = Map<string, { names: Set<string>; since: Order }>;

// Importers evaluated before `since` hold the previous exports: an earlier update, or, when the
// module was evaluated repeatedly in one update, an earlier evaluation of it.
function changesSince(update: StagedUpdate): Order {
  return { cycle: update.cycle, seq: update.repeated ? update.seq : 0 };
}

function addChanges(changes: Changes, id: string, names: Iterable<string>, since: Order): void {
  const entry = changes.get(id);
  if (entry === undefined) changes.set(id, { names: new Set(names), since });
  else {
    for (const name of names) entry.names.add(name);
    if (precedes(entry.since, since)) entry.since = since;
  }
}

// Modules to re-evaluate for changed exports: modules using them sensitively, followed through
// barrels that export them again (the barrels themselves hold the previous module's bindings).
// `reached` is every module whose exports the change reaches, with those exports.
// A module evaluated in this batch is current unless it was evaluated before the changed exports
// (`since`, e.g. a retried or superseded batch). Within one update, modules of an import cycle hold
// live bindings to each other and are current.
function propagate(
  changes: Changes,
  evaluated: ReadonlyMap<string, Order>,
): { readonly rebind: Set<string>; readonly reached: Map<string, Set<string>> } {
  const rebind = new Set<string>();
  const stale = (id: string, since: Order): boolean => {
    const order = evaluated.get(id);
    return order === undefined || precedes(order, since);
  };
  const reached = new Map<string, Set<string>>();
  const queue = [...changes].map(([id, { names, since }]) => [id, names, since] as const);
  while (queue.length > 0) {
    const [id, names, since] = queue.pop()!;
    const known = reached.get(id) ?? new Set<string>();
    const fresh = known.has(ALL) ? [] : [...names].filter((name) => !known.has(name));
    if (fresh.length === 0) continue;
    for (const name of fresh) known.add(name);
    reached.set(id, known);
    const all = fresh.includes(ALL);
    for (const [user, used] of dependencies.into(id)) {
      if (!stale(user, since)) continue;
      if (all || used.has(ALL) || fresh.some((name) => used.has(name))) rebind.add(user);
    }
    for (const [barrel, mapping] of reexports.into(id)) {
      const exported = reexportedNames(mapping, fresh);
      if (exported.size === 0) continue;
      if (stale(barrel, since)) rebind.add(barrel);
      // Followed even when the barrel is current: its importers may not be.
      queue.push([barrel, exported, since]);
    }
  }
  return { rebind, reached };
}

// What an evaluation changes against the applied version of its module: the export bindings
// importers hold, and the classes replaced (with the names exporting them).
function diff(record: HotRecord, update: StagedUpdate) {
  const changed = new Set<string>();
  for (const name of changedExportNames(record.signature, update.signature)) {
    changed.add(name.startsWith("*") ? ALL : name);
  }
  for (const [name, next] of update.values) {
    // Replaced classes are handled by DI and by rebinding sensitive importers, not as values.
    const isClassExport = record.classExports.has(name) && update.classExports.has(name);
    if (!Object.is(record.values.get(name), next) && !isClassExport) changed.add(name);
  }
  const classes: ClassPair[] = [];
  const replaced = new Set<string>();
  for (const [local, next] of update.classes) {
    // A renamed local keeps its identity through the export holding it.
    const exportName = [...update.values].find(
      ([name, value]) => value === next && update.classExports.has(name),
    )?.[0];
    const prev =
      record.appliedClasses.get(local) ??
      (exportName !== undefined && record.classExports.has(exportName)
        ? (record.values.get(exportName) as Function | undefined)
        : undefined);
    if (prev === undefined || prev === next) continue;
    classes.push([prev as ServiceConstructor<unknown>, next as ServiceConstructor<unknown>]);
    for (const [name, value] of update.values) if (value === next) replaced.add(name);
  }
  return { changed, classes, replaced };
}

function applyPending(): void {
  if (pending.size === 0) return;
  const batch = [...pending];
  const classes: ClassPair[] = [];
  const replacedExports: Changes = new Map();
  // Exports whose binding changed, whether or not the batch applies: importers holding the
  // previous bindings can only become consistent with this version by being re-evaluated.
  const changedBindings: Changes = new Map();
  for (const [record, update] of batch) {
    const { changed, classes: pairs, replaced } = diff(record, update);
    if (!update.rebound && changed.size > 0) {
      addChanges(changedBindings, record.id, changed, changesSince(update));
    }
    classes.push(...pairs);
    if (replaced.size > 0) addChanges(replacedExports, record.id, replaced, changesSince(update));
  }

  const previousImpls = new Map<Forwarder, Function>();
  const undoEffects: Array<() => void> = [];
  const previousLatest = classes.map(([prev]) => latestClass(prev));
  // Services rebuilt by the batch keep their previous instances until the whole batch succeeded.
  beginScopeTransaction();
  const errors = batchScopeUpdates(() => {
    for (const [, update] of batch) {
      for (const effect of update.effects) undoEffects.push(effect());
    }
    for (const [, update] of batch) {
      for (const [forwarder, impl] of update.impls) {
        if (!previousImpls.has(forwarder)) previousImpls.set(forwarder, forwarder.impl);
        setImpl(forwarder, impl);
      }
    }
    for (const [prev, next] of classes) replaceService(prev, next);
    for (const [record] of batch) record.version.value++;
  });

  const failed = errors.length > 0;
  if (failed) {
    const rollbackErrors = batchScopeUpdates(() => {
      for (const [forwarder, impl] of previousImpls) setImpl(forwarder, impl);
      rollbackScopeTransaction().forEach((error) => errors.push(error));
      classes.forEach(([, next], index) => registerClassVersion(next, previousLatest[index]!));
      for (const undo of undoEffects.reverse()) undo();
      for (const [record] of batch) record.version.value++;
    });
    console.error(
      `[hmr] update of ${batch.length} module(s) rejected; keeping the previous versions and retrying with the next update:`,
      ...errors,
      ...rollbackErrors,
    );
  } else {
    const releaseErrors = commitScopeTransaction();
    if (releaseErrors.length > 0) console.error("[hmr] releasing previous service instances failed:", ...releaseErrors);
    pending.clear();
    for (const [record, update] of batch) {
      record.values = update.values;
      record.data = update.data;
      record.classExports = update.classExports;
      record.appliedClasses = update.classes;
      record.signature = update.signature;
    }
  }
  // Modules that extend, construct or otherwise hold a replaced class are re-evaluated alone;
  // modules that only hand it to DI keep running against the latest version.
  const evaluated = new Map(batch.map(([record, update]) => [record.id, { cycle: update.cycle, seq: update.seq }]));
  const bindings = propagate(changedBindings, evaluated);
  // Replaced classes only when applied; changed bindings are re-bound even after a rejection.
  const replacedClasses = failed ? undefined : propagate(replacedExports, evaluated);
  for (const [, update] of batch) update.rebound = true;
  sendRebind(batch[0]![1].hot, bindings, replacedClasses);
}

function sendRebind(
  hot: HotContext,
  bindings: ReturnType<typeof propagate>,
  replacedClasses: ReturnType<typeof propagate> | undefined,
): void {
  const ids = new Set([...bindings.rebind, ...(replacedClasses?.rebind ?? [])]);
  const reached = new Set([...bindings.reached.keys(), ...(replacedClasses?.reached.keys() ?? [])]);
  if (ids.size === 0 && reached.size === 0) return;
  const names = (exports: ReadonlyMap<string, ReadonlySet<string>> = new Map()) =>
    Object.fromEntries([...exports].map(([id, exported]) => [id, [...exported]]));
  hot.send("harness:hmr-rebind", {
    ids: [...ids],
    replaced: names(replacedClasses?.reached),
    changed: names(bindings.reached),
    instrumented: dependencies.sources(),
    recorded: Object.fromEntries([...reached].map((id) => [id, [...dependencies.into(id).keys()]])),
  });
}
