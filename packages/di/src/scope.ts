import { canonicalClass, latestClass, registerClassVersion } from "@harness/hot";
import {
  computed,
  effectScope,
  onScopeDispose,
  pauseTracking,
  resetTracking,
  shallowRef,
  watchSyncEffect,
  type ComputedRef,
  type EffectScope,
  type ShallowRef,
  type WatchHandle,
} from "reactivity";
import { getOrCreate } from "./collections.ts";
import {
  Descriptor,
  isSameDescriptor,
  toServiceIdentifier,
  type AbstractServiceConstructor,
  type ServiceConstructor,
  type ServiceIdentifier,
} from "./descriptors.ts";
import {
  InstantiationService,
  normalizeServiceEntry,
  runInInjectionContext,
  type InjectionContext,
  type ServiceEntries,
  type ServiceEntry,
} from "./instantiation.ts";

type Entry = readonly [ServiceIdentifier<unknown>, Descriptor<unknown>];
type Owned = Map<Scope, Set<ServiceIdentifier<unknown>>>;

function untracked<T>(fn: () => T): T {
  pauseTracking();
  try {
    return fn();
  } finally {
    resetTracking();
  }
}

function stopUntracked(scope: EffectScope | undefined): void {
  if (scope !== undefined) untracked(() => scope.stop());
}

// Registrations are tracked per class family, so a replacement reaches every registration made
// with any version of the class.
const implRegistry = new WeakMap<Function, Map<Scope, Set<ServiceIdentifier<unknown>>>>();

function trackImpl(ctor: Function, scope: Scope, id: ServiceIdentifier<unknown>): void {
  const byScope = getOrCreate(implRegistry, canonicalClass(ctor), () => new Map());
  getOrCreate(byScope, scope, () => new Set()).add(id);
}

function untrackImpl(ctor: Function, scope: Scope, id: ServiceIdentifier<unknown>): void {
  const byScope = implRegistry.get(canonicalClass(ctor));
  const ids = byScope?.get(scope);
  if (ids?.delete(id) && ids.size === 0) byScope!.delete(scope);
}

export function replaceService<T>(
  prevCtor: ServiceConstructor<T>,
  nextCtor: ServiceConstructor<T>,
): number {
  const prevLatest = latestClass(prevCtor);
  registerClassVersion(prevCtor, nextCtor);
  const family = canonicalClass(prevCtor);
  const targets = [...(implRegistry.get(family) ?? [])].flatMap(([scope, ids]) =>
    scope.isDisposed ? [] : [...ids].map((id) => [scope, id] as const),
  );
  const done: Array<readonly [Scope, ServiceIdentifier<unknown>, Descriptor<unknown>]> = [];
  try {
    for (const [scope, id] of targets) {
      const prev = scope.getDescriptor(id);
      if (prev === undefined || prev.ctor === nextCtor || canonicalClass(prev.ctor) !== family) continue;
      scope._replace(id, new Descriptor(nextCtor, prev.staticArguments));
      done.push([scope, id, prev]);
    }
  } catch (error) {
    // The failed scope restored itself; put back the others and the version constructed.
    registerClassVersion(nextCtor, prevLatest);
    for (const [scope, id, prev] of done.reverse()) {
      if (!scope.isDisposed) scope._replace(id, prev);
    }
    throw error;
  }
  return done.length;
}

export class CyclicDependencyError extends Error {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    super(`cyclic dependency between services: ${path.join(" -> ")}`);
    this.name = "CyclicDependencyError";
    this.path = path;
  }
}

export interface ScopeOptions {
  readonly id?: string;
}

export abstract class CurrentScope {
  abstract readonly id: string;
  abstract createChild(options?: ScopeOptions): Scope;
}

interface SetupRecord {
  readonly host: Scope;
  watcher: WatchHandle;
  scope?: EffectScope;
  owned: Owned;
  // What the run in progress provides.
  collecting?: Owned;
  // Nested setups created by the current run.
  children: SetupRecord[];
}

let activeSetup: SetupRecord | undefined;
let setupErrorSink: ((error: unknown) => void) | undefined;

function reportSetupError(error: unknown): void {
  if (setupErrorSink === undefined) throw error;
  setupErrorSink(error);
}

const liveRoots = new Set<Scope>();
let batchDepth = 0;

/**
 * @internal Runs `fn` with every service and setup watcher of every live scope paused, so the
 * changes it makes are observed together once it returns. Returns the errors thrown by `fn` and by
 * the re-computation it caused instead of throwing them.
 */
export function batchScopeUpdates(fn: () => void): unknown[] {
  const errors: unknown[] = [];
  const watchers =
    batchDepth === 0 ? [...liveRoots].flatMap((root) => root._collectWatchers()) : [];
  for (const watcher of watchers) watcher.pause();
  const prevSink = setupErrorSink;
  setupErrorSink = (error) => errors.push(error);
  batchDepth++;
  try {
    fn();
  } catch (error) {
    errors.push(error);
  } finally {
    batchDepth--;
    try {
      for (const watcher of watchers) {
        try {
          watcher.resume();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      setupErrorSink = prevSink;
    }
  }
  return errors;
}

function addOwned(target: Owned, scope: Scope, id: ServiceIdentifier<unknown>): void {
  getOrCreate(target, scope, () => new Set()).add(id);
}

function takeDescendants(record: SetupRecord): SetupRecord[] {
  const all: SetupRecord[] = [];
  const visit = (parent: SetupRecord): void => {
    for (const child of parent.children) {
      all.push(child);
      visit(child);
    }
    parent.children = [];
  };
  visit(record);
  return all;
}

// A setup stopped by its enclosing re-run keeps nothing the new run provided again.
interface Release {
  readonly scope: Scope;
  readonly id: ServiceIdentifier<unknown>;
  readonly owner: SetupRecord;
}

function ownedReleases(owner: SetupRecord, owned: Owned, keep?: Owned): Release[] {
  return [...owned].flatMap(([scope, ids]) =>
    [...ids].reverse().flatMap((id) => (keep?.get(scope)?.has(id) ? [] : [{ scope, id, owner }])),
  );
}

// A service another one still depends on can only go after it, whichever setup owns either, so
// releases retry until nothing moves. What cannot be released stays owned by `heir`.
function releaseAll(releases: readonly Release[], heir: SetupRecord, errors: unknown[]): void {
  let queue = releases.filter(({ scope }) => !scope.isDisposed);
  for (;;) {
    const failed: Array<readonly [Release, unknown]> = [];
    for (const release of queue) {
      try {
        release.scope.releaseOwned(release.id, release.owner);
      } catch (error) {
        failed.push([release, error]);
      }
    }
    if (failed.length === 0 || failed.length === queue.length) {
      for (const [{ scope, id, owner }, error] of failed) {
        errors.push(error);
        scope.transferOwned(id, owner, heir);
        addOwned(heir.owned, scope, id);
      }
      return;
    }
    queue = failed.map(([release]) => release);
  }
}

function adoptOwned(record: SetupRecord, stale: SetupRecord): void {
  for (const [scope, ids] of stale.owned) {
    for (const id of ids) {
      scope.transferOwned(id, stale, record);
      addOwned(record.owned, scope, id);
    }
  }
}

function runningSetup(caller: string): SetupRecord {
  const setup = activeSetup;
  if (setup?.collecting === undefined) {
    throw new Error(`${caller} can only be called inside a setup`);
  }
  return setup;
}

/** Runs a setup nested in the running one; it re-runs on its own dependencies. */
export function useSetup(fn: () => void): void {
  const parent = runningSetup("useSetup()");
  parent.host._createSetup(fn, parent);
}

/**
 * Defines a setup unit: each call runs `fn` with the call's arguments as a setup nested in the
 * running one, like `useSetup(() => fn(...args))`.
 */
export function defineSetup<Args extends unknown[]>(
  fn: (...args: Args) => void,
): (...args: Args) => void {
  return (...args) => {
    const parent = runningSetup(`${fn.name || "A setup unit"}()`);
    parent.host._createSetup(() => fn(...args), parent);
  };
}

/** Provides services into the running setup's scope, owned by that setup. */
export function useServices(entries: ServiceEntries): void {
  runningSetup("useServices()").host.provideAll(entries);
}

const MISSING = Symbol("missing service");

interface TransactionEntry {
  undo?(): void;
  commit?(): void;
}

// While a provide or unprovide (or a hot update batch) runs, its effects are logged: rebuilt
// services keep their previous instance alive, and a failure undoes slots, nodes, registrations
// and rebuilds; committing releases the previous instances. Nested transactions join the outer.
const transactions: TransactionEntry[][] = [];

function logged(entry: TransactionEntry): void {
  const transaction = transactions.at(-1);
  if (transaction !== undefined) transaction.push(entry);
  else entry.commit?.();
}

function trackLogged(ctor: Function, scope: Scope, id: ServiceIdentifier<unknown>): void {
  trackImpl(ctor, scope, id);
  logged({ undo: () => untrackImpl(ctor, scope, id) });
}

function untrackLogged(ctor: Function, scope: Scope, id: ServiceIdentifier<unknown>): void {
  untrackImpl(ctor, scope, id);
  logged({ undo: () => trackImpl(ctor, scope, id) });
}

/** @internal */
export function beginScopeTransaction(): void {
  transactions.push([]);
}

/** @internal Returns errors of releasing previous instances; the state is committed regardless. */
export function commitScopeTransaction(): unknown[] {
  const log = transactions.pop()!;
  const parent = transactions.at(-1);
  if (parent !== undefined) {
    parent.push(...log);
    return [];
  }
  return collectErrors(log, (entry) => entry.commit?.());
}

/** @internal */
export function rollbackScopeTransaction(): unknown[] {
  return collectErrors(transactions.pop()!.reverse(), (entry) => entry.undo?.());
}

function collectErrors<T>(items: readonly T[], run: (item: T) => void): unknown[] {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      run(item);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

// Releasing previous instances failed after the change was committed.
function throwErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "releasing previous service instances failed");
}

interface ServiceNode {
  readonly instance: ComputedRef<unknown>;
  watcher?: WatchHandle;
  scope?: EffectScope;
  built?: {
    readonly descriptor: Descriptor<unknown>;
    readonly ctor: Function;
    readonly deps: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>;
    readonly instance: unknown;
  };
}

const resolving: Array<{ readonly scope: Scope; readonly id: ServiceIdentifier<unknown> }> = [];
let nextChildId = 0;

function serviceName(id: ServiceIdentifier<unknown>): string {
  return id.name || "<anonymous>";
}

type CreateInstance = (
  ctorOrDescriptor: ServiceConstructor<unknown> | Descriptor<unknown>,
  args: unknown[],
) => unknown;

class ScopeInstantiationService extends InstantiationService {
  readonly #create: CreateInstance;

  constructor(create: CreateInstance) {
    super();
    this.#create = create;
  }

  override createInstance<T>(descriptor: Descriptor<T>): T;
  override createInstance<Ctor extends ServiceConstructor<any>>(
    ctor: Ctor,
    ...args: ConstructorParameters<Ctor>
  ): InstanceType<Ctor>;
  override createInstance(
    ctorOrDescriptor: ServiceConstructor<unknown> | Descriptor<unknown>,
    ...args: unknown[]
  ): unknown {
    return this.#create(ctorOrDescriptor, args);
  }
}

class ScopeCurrentScope extends CurrentScope {
  readonly #scope: Scope;

  constructor(scope: Scope) {
    super();
    this.#scope = scope;
  }

  override get id(): string {
    return this.#scope.id;
  }

  override createChild(options?: ScopeOptions): Scope {
    return this.#scope.createChild(options);
  }
}

export class Scope {
  readonly id: string;
  readonly parent: Scope | undefined;
  readonly children = new Map<string, Scope>();

  private readonly _effectScope: EffectScope;
  // The setup whose provide last wrote each slot; replacements keep it.
  private readonly _owners = new Map<ServiceIdentifier<unknown>, SetupRecord>();
  private readonly _slots = new Map<
    ServiceIdentifier<unknown>,
    ShallowRef<Descriptor<unknown> | undefined>
  >();
  private readonly _nodes = new Map<ServiceIdentifier<unknown>, ServiceNode>();
  private readonly _setupWatchers: SetupRecord[] = [];
  private readonly _instantiation: InstantiationService;
  private readonly _currentScope = new ScopeCurrentScope(this);
  private _disposed = false;

  private constructor(id: string, parent?: Scope) {
    this.id = id;
    this.parent = parent;
    this._effectScope = parent ? parent._effectScope.run(() => effectScope())! : effectScope(true);
    this._effectScope.run(() => onScopeDispose(() => this.dispose()));
    this._instantiation = this._createInstantiation(this._effectScope);
  }

  static createRoot(options: ScopeOptions = {}): Scope {
    const root = new Scope(options.id ?? "root");
    liveRoots.add(root);
    return root;
  }

  get isRoot(): boolean {
    return this.parent === undefined;
  }

  get root(): Scope {
    return this.parent?.root ?? this;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get<T>(rawId: AbstractServiceConstructor<T>): T {
    this._assertNotDisposed();
    const id = toServiceIdentifier(rawId, "scope.get()");
    if (id === (InstantiationService as ServiceIdentifier<unknown>)) {
      return this._instantiation as T;
    }
    if (id === (CurrentScope as ServiceIdentifier<unknown>)) {
      return this._currentScope as T;
    }
    const owner = this._resolveOwner(id);
    if (owner === undefined) {
      throw new Error(`unknown service '${serviceName(id)}'`);
    }
    const start = resolving.findIndex((frame) => frame.scope === owner && frame.id === id);
    if (start !== -1) {
      const path = resolving.slice(start).map((frame) => serviceName(frame.id));
      throw new CyclicDependencyError([...path, serviceName(id)]);
    }
    return owner._nodes.get(id)!.instance.value as T;
  }

  getOptional<T>(rawId: AbstractServiceConstructor<T>): T | undefined {
    this._assertNotDisposed();
    const id = toServiceIdentifier(rawId, "scope.getOptional()");
    if (id === (InstantiationService as ServiceIdentifier<unknown>)) {
      return this._instantiation as T;
    }
    if (id === (CurrentScope as ServiceIdentifier<unknown>)) {
      return this._currentScope as T;
    }
    return this._resolveOwner(id) === undefined ? undefined : this.get(rawId);
  }

  run<T>(fn: () => T): T {
    this._assertNotDisposed();
    return this._effectScope.run(() => runInInjectionContext(this, fn))!;
  }

  setup(fn: () => void): void {
    this._assertNotDisposed();
    this._setupWatchers.push(this._createSetup(fn, undefined));
  }

  /** @internal */
  _createSetup(fn: () => void, parent: SetupRecord | undefined): SetupRecord {
    const record: SetupRecord = { host: this, watcher: undefined!, owned: new Map(), children: [] };
    // Registered before the first run so a failing first run still hands its services over.
    parent?.children.push(record);
    const container = parent?.scope ?? this._effectScope;
    // Cleanups of the previous run are not dependencies of the next one.
    const stopRun = (): void => {
      const scope = record.scope;
      record.scope = undefined;
      stopUntracked(scope);
    };
    let initialized = false;
    let firstError: { readonly error: unknown } | undefined;
    record.watcher = container.run(() =>
      watchSyncEffect(() => {
        const stale = takeDescendants(record);
        stopRun();
        const setupScope = container.run(() => effectScope())!;
        record.scope = setupScope;
        const parentSetup = activeSetup;
        const collecting: Owned = new Map();
        record.collecting = collecting;
        activeSetup = record;
        try {
          setupScope.run(() => runInInjectionContext(this, fn));
        } catch (error) {
          activeSetup = parentSetup;
          record.collecting = undefined;
          for (const [scope, ids] of collecting) for (const id of ids) addOwned(record.owned, scope, id);
          for (const child of [...stale, ...takeDescendants(record)]) adoptOwned(record, child);
          if (record.scope === setupScope) stopRun();
          // Raised once the handle exists, so the watcher can be stopped.
          if (initialized) reportSetupError(error);
          else firstError = { error };
          return;
        }
        activeSetup = parentSetup;
        record.collecting = undefined;
        const prevOwned = record.owned;
        record.owned = collecting;
        // The run itself succeeded and stays in place; only report what could not be released.
        const releaseErrors: unknown[] = [];
        releaseAll(
          [
            ...ownedReleases(record, prevOwned, collecting),
            ...stale.flatMap((child) => ownedReleases(child, child.owned)),
          ],
          record,
          releaseErrors,
        );
        for (const error of releaseErrors) reportSetupError(error);
      }),
    )!;
    initialized = true;
    if (firstError !== undefined) {
      record.watcher.stop();
      if (parent !== undefined) parent.children.splice(parent.children.indexOf(record), 1);
      // What cannot be released stays provided; the run's own error is the one to report.
      releaseAll(ownedReleases(record, record.owned), record, []);
      throw firstError.error;
    }
    return record;
  }

  onDispose(fn: () => void): void {
    this._assertNotDisposed();
    this._effectScope.run(() => onScopeDispose(fn));
  }

  createInstance<T>(descriptor: Descriptor<T>): T;
  createInstance<Ctor extends ServiceConstructor<any>>(
    ctor: Ctor,
    ...args: ConstructorParameters<Ctor>
  ): InstanceType<Ctor>;
  createInstance(
    ctorOrDescriptor: ServiceConstructor<unknown> | Descriptor<unknown>,
    ...args: unknown[]
  ): unknown {
    this._assertNotDisposed();
    return this._effectScope.run(() =>
      this._createInstance(ctorOrDescriptor, args, this._instantiation),
    );
  }

  createChild(options: ScopeOptions = {}): Scope {
    this._assertNotDisposed();
    const id = options.id ?? this._nextGeneratedId();
    if (this.children.has(id)) {
      throw new Error(`scope '${this.id}' already has a child with id '${id}'`);
    }
    const child = new Scope(id, this);
    this.children.set(id, child);
    return child;
  }

  provide<T>(ctorOrDescriptor: ServiceConstructor<T> | Descriptor<T>): void;
  provide<T>(
    id: AbstractServiceConstructor<T>,
    ctorOrDescriptor: ServiceConstructor<T> | Descriptor<T>,
  ): void;
  provide<T>(
    idOrEntry: AbstractServiceConstructor<T> | ServiceConstructor<T> | Descriptor<T>,
    ctorOrDescriptor?: ServiceConstructor<T> | Descriptor<T>,
  ): void {
    const entry: ServiceEntry =
      ctorOrDescriptor !== undefined
        ? [idOrEntry as AbstractServiceConstructor<T>, ctorOrDescriptor]
        : (idOrEntry as ServiceConstructor<T> | Descriptor<T>);
    this.provideAll([entry]);
  }

  provideAll(entries: ServiceEntries): void {
    this._assertNotDisposed();
    untracked(() => this._provide(entries.map(normalizeServiceEntry), false));
  }

  /** @internal Puts a new version of a class in place of the current one, keeping its owner. */
  _replace(id: ServiceIdentifier<unknown>, descriptor: Descriptor<unknown>): void {
    this._assertNotDisposed();
    untracked(() => this._provide([[id, descriptor]], true));
  }

  private _provide(entries: readonly Entry[], replacement: boolean): void {
    // The last entry for an id wins.
    const last = new Map<ServiceIdentifier<unknown>, Descriptor<unknown>>();
    for (const [id, descriptor] of entries) {
      const prev = last.get(id);
      if (prev !== undefined && prev.ctor !== descriptor.ctor) {
        throw new Error(
          `Duplicate service identifier "${id.name}" with different implementations in provideAll()`,
        );
      }
      last.set(id, descriptor);
    }
    // A setup owns what it provides into its own scope; services it triggers manage their own.
    const owner =
      !replacement && activeSetup?.collecting !== undefined && activeSetup.host === this
        ? activeSetup
        : undefined;
    if (owner !== undefined) for (const id of last.keys()) addOwned(owner.collecting!, this, id);
    const claim = (): void => {
      if (replacement) return;
      for (const id of last.keys()) {
        const prev = this._owners.get(id);
        if (owner === undefined) this._owners.delete(id);
        else this._owners.set(id, owner);
        logged({ undo: () => (prev === undefined ? this._owners.delete(id) : this._owners.set(id, prev)) });
      }
    };
    // Replacements always re-create: their descriptor equals the current one by latest version.
    const changed = [...last].filter(([id, descriptor]) => {
      const current = this._slots.get(id)?.value;
      return replacement || current === undefined || !isSameDescriptor(current, descriptor);
    });
    if (changed.length === 0) {
      claim();
      return;
    }
    this._transact(() => {
      const added: ServiceIdentifier<unknown>[] = [];
      for (const [id, descriptor] of changed) {
        const slot = this._slot(id);
        const prev = slot.value;
        slot.value = descriptor;
        logged({ undo: () => void (slot.value = prev) });
        if (prev !== undefined) untrackLogged(prev.ctor, this, id);
        trackLogged(descriptor.ctor, this, id);
        if (!this._nodes.has(id)) {
          added.push(id);
          this._createNode(id);
          logged({ undo: () => this._removeNode(id) });
        }
      }
      for (const id of added) this._watchNode(id);
      claim();
    });
  }

  // Watchers are paused while the change is made, so dependents recompute once against all of it.
  private _transact(change: () => void, except?: WatchHandle): void {
    const watchers =
      batchDepth > 0 ? [] : this._collectWatchers().filter((watcher) => watcher !== except);
    for (const watcher of watchers) watcher.pause();
    beginScopeTransaction();
    try {
      change();
      for (const watcher of watchers) watcher.resume();
    } catch (error) {
      rollbackScopeTransaction();
      for (const watcher of watchers) watcher.resume();
      throw error;
    }
    throwErrors(commitScopeTransaction());
  }

  unprovide<T>(rawId: AbstractServiceConstructor<T>): void {
    this._assertNotDisposed();
    const id = toServiceIdentifier(rawId, "scope.unprovide()");
    untracked(() => this._unprovide(id));
  }

  /** @internal */
  transferOwned(id: ServiceIdentifier<unknown>, from: SetupRecord, to: SetupRecord): void {
    if (this._owners.get(id) === from) this._owners.set(id, to);
  }

  /** @internal */
  releaseOwned(id: ServiceIdentifier<unknown>, record: SetupRecord): void {
    if (this._owners.get(id) === record) this.unprovide(id as AbstractServiceConstructor<unknown>);
  }

  private _unprovide(id: ServiceIdentifier<unknown>): void {
    const slot = this._slots.get(id);
    const prev = slot?.value;
    if (slot === undefined || prev === undefined) {
      this._owners.delete(id);
      return;
    }
    const node = this._nodes.get(id);
    this._transact(() => {
      slot.value = undefined;
      logged({ undo: () => void (slot.value = prev) });
      untrackLogged(prev.ctor, this, id);
      const owner = this._owners.get(id);
      this._owners.delete(id);
      logged({ undo: () => void (owner !== undefined && this._owners.set(id, owner)) });
      if (node !== undefined) {
        logged({
          commit: () => {
            if (this._nodes.get(id) === node && slot.value === undefined) this._removeNode(id);
          },
        });
      }
    }, node?.watcher);
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    liveRoots.delete(this);
    this.parent?.children.delete(this.id);
    const children = [...this.children.values()].reverse();
    this.children.clear();
    const setupWatchers = [...this._setupWatchers].reverse();
    this._setupWatchers.length = 0;
    try {
      for (const child of children) {
        child.dispose();
      }
      for (const record of setupWatchers) {
        record.watcher.stop();
        record.scope?.stop();
      }
      for (const node of [...this._nodes.values()].reverse()) {
        node.watcher?.stop();
        node.scope?.stop();
      }
    } finally {
      for (const [id, slot] of this._slots) {
        if (slot.value !== undefined) untrackImpl(slot.value.ctor, this, id);
      }
      this._nodes.clear();
      this._slots.clear();
      this._owners.clear();
      this._effectScope.stop();
    }
  }

  /** @internal */
  getDescriptor(id: ServiceIdentifier<unknown>): Descriptor<unknown> | undefined {
    return this._slots.get(id)?.value;
  }

  private _createNode(id: ServiceIdentifier<unknown>): void {
    const slot = this._slot(id);
    const instance = computed(() => {
      const descriptor = slot.value;
      if (descriptor === undefined) {
        return undefined;
      }
      const node = this._nodes.get(id)!;
      const ctor = latestClass(descriptor.ctor);
      // Construction is a function of the descriptor, the class version and the resolved
      // dependencies: a recompute with all of them unchanged (e.g. a slot written and then
      // restored by a rollback) keeps the instance.
      const built = node.built;
      if (
        built !== undefined &&
        built.descriptor === descriptor &&
        built.ctor === ctor &&
        built.deps.every(([depId, value]) => this._tryGet(depId) === value)
      ) {
        return built.instance;
      }

      const serviceScope = this._effectScope.run(() => effectScope())!;
      const instantiation = this._createInstantiation(serviceScope);
      const deps: Array<readonly [ServiceIdentifier<unknown>, unknown]> = [];
      const injectionContext: InjectionContext = {
        get: <T>(depId: ServiceIdentifier<T>): T => {
          if (depId === (InstantiationService as ServiceIdentifier<unknown>)) {
            return instantiation as T;
          }
          resetTracking();
          try {
            const value = this.get(depId);
            deps.push([depId, value]);
            return value;
          } catch (error) {
            // A constructor may treat a missing service as optional: providing it later changes
            // the construction.
            deps.push([depId, MISSING]);
            throw error;
          } finally {
            pauseTracking();
          }
        },
        getOptional: <T>(depId: ServiceIdentifier<T>): T | undefined => {
          if (depId === (InstantiationService as ServiceIdentifier<unknown>)) {
            return instantiation as T;
          }
          resetTracking();
          try {
            const value = this.getOptional(depId);
            deps.push([depId, value === undefined ? MISSING : value]);
            return value;
          } catch (error) {
            deps.push([depId, MISSING]);
            throw error;
          } finally {
            pauseTracking();
          }
        },
      };

      resolving.push({ scope: this, id });
      const enclosingSetup = activeSetup;
      activeSetup = undefined;
      let next: unknown;
      try {
        next = serviceScope.run(() =>
          untracked(() =>
            runInInjectionContext(injectionContext, () => new ctor(...descriptor.staticArguments)),
          ),
        );
      } catch (error) {
        // The previous instance stays until a replacement exists (#333).
        serviceScope.stop();
        throw error;
      } finally {
        activeSetup = enclosingSetup;
        resolving.pop();
      }
      const prevScope = node.scope;
      const prevBuilt = node.built;
      node.scope = serviceScope;
      node.built = { descriptor, ctor, deps, instance: next };
      logged({
        undo: () => {
          node.scope = prevScope;
          node.built = prevBuilt;
          stopUntracked(serviceScope);
        },
        commit: () => stopUntracked(prevScope),
      });
      return next;
    });

    this._nodes.set(id, { instance });
  }

  private _tryGet(id: ServiceIdentifier<unknown>): unknown {
    try {
      return this.get(id);
    } catch {
      return MISSING;
    }
  }

  // Dropped first, so a cleanup that throws leaves no stale node behind.
  private _removeNode(id: ServiceIdentifier<unknown>): void {
    const node = this._nodes.get(id);
    this._nodes.delete(id);
    node?.watcher?.stop();
    stopUntracked(node?.scope);
  }

  private _watchNode(id: ServiceIdentifier<unknown>): void {
    const node = this._nodes.get(id)!;
    // An error in the first run would leave no handle to stop the watcher with, so it is raised
    // only after the handle is stored.
    let initialRun = true;
    let initialError: { readonly error: unknown } | undefined;
    node.watcher = this._effectScope.run(() =>
      watchSyncEffect(() => {
        if (!initialRun) {
          void node.instance.value;
          return;
        }
        try {
          void node.instance.value;
        } catch (error) {
          initialError = { error };
        }
      }),
    )!;
    initialRun = false;
    if (initialError !== undefined) throw initialError.error;
  }

  private _createInstantiation(targetScope: EffectScope): InstantiationService {
    const instantiation: InstantiationService = new ScopeInstantiationService(
      (ctorOrDescriptor, args) =>
        targetScope.run(() => this._createInstance(ctorOrDescriptor, args, instantiation)),
    );
    return instantiation;
  }

  private _createInstance(
    ctorOrDescriptor: ServiceConstructor<unknown> | Descriptor<unknown>,
    args: unknown[],
    instantiation: InstantiationService,
  ): unknown {
    const [ctor, staticArgs] =
      typeof ctorOrDescriptor === "function"
        ? [ctorOrDescriptor, args]
        : [ctorOrDescriptor.ctor, [...ctorOrDescriptor.staticArguments, ...args]];
    const injectionContext: InjectionContext = {
      get: <T>(depId: ServiceIdentifier<T>): T =>
        depId === (InstantiationService as ServiceIdentifier<unknown>)
          ? (instantiation as T)
          : this.get(depId),
      getOptional: <T>(depId: ServiceIdentifier<T>): T | undefined =>
        depId === (InstantiationService as ServiceIdentifier<unknown>)
          ? (instantiation as T)
          : this.getOptional(depId),
    };
    return untracked(() =>
      runInInjectionContext(injectionContext, () => new (latestClass(ctor))(...staticArgs)),
    );
  }

  private _slot(id: ServiceIdentifier<unknown>): ShallowRef<Descriptor<unknown> | undefined> {
    return getOrCreate(this._slots, id, () => shallowRef(undefined));
  }

  // Reading the slot of a missing service too, so providing it later re-runs the reader.
  private _resolveOwner(id: ServiceIdentifier<unknown>): Scope | undefined {
    return this._slot(id).value !== undefined ? this : this.parent?._resolveOwner(id);
  }

  /** @internal */
  _collectWatchers(): WatchHandle[] {
    const watchers: WatchHandle[] = [];
    const visit = (record: SetupRecord): void => {
      // A nested setup in its first run has no handle yet.
      if (record.watcher !== undefined) watchers.push(record.watcher);
      for (const child of record.children) visit(child);
    };
    const collect = (scope: Scope): void => {
      for (const node of scope._nodes.values()) {
        if (node.watcher !== undefined) watchers.push(node.watcher);
      }
      for (const record of scope._setupWatchers) visit(record);
      for (const child of scope.children.values()) collect(child);
    };
    collect(this);
    return watchers;
  }

  private _nextGeneratedId(): string {
    let id = `scope-${++nextChildId}`;
    while (this.children.has(id)) {
      id = `scope-${++nextChildId}`;
    }
    return id;
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(`scope '${this.id}' has been disposed`);
    }
  }
}

export function createRootScope(options: ScopeOptions = {}): Scope {
  return Scope.createRoot(options);
}
