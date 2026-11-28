import { describe, expect, it } from "vite-plus/test";
import {
  onScopeDispose,
  shallowRef,
  type ShallowRef,
} from "../../packages/di/node_modules/reactivity/dist/index.js";
import {
  createDescriptor,
  createRootScope,
  CurrentScope,
  inject,
  replaceService,
  type Scope,
  useServices,
  useSetup,
} from "../../packages/di/src/index.ts";
import { batchScopeUpdates } from "../../packages/di/src/scope.ts";

const SEEDS = Array.from({ length: 150 }, (_, index) => index + 1);
const STEPS = 50;

// Listed so that every family comes after the ones it depends on.
const FAMILIES = ["A", "E", "Cfg", "Host", "B", "D"] as const;
type Family = (typeof FAMILIES)[number];
const DEPS: Record<Family, readonly Family[]> = {
  A: [],
  E: [],
  Cfg: [],
  Host: [],
  B: ["A"],
  D: ["B", "Cfg"],
};

type ScopeName = "R" | "C";
type TopName = "RS" | "CS";
type SetupName = TopName | "RN" | "CN";
const NESTED: Record<TopName, SetupName> = { RS: "RN", CS: "CN" };
const HOST: Record<TopName, ScopeName> = { RS: "R", CS: "C" };

interface Entry {
  readonly family: Family;
  readonly n: number;
  readonly version: number;
  readonly descriptor: boolean;
}

interface Config {
  readonly entries: readonly Entry[];
  readonly throwAt: "none" | "before" | "after";
  readonly nested: boolean;
}

type Op =
  | { readonly kind: "flip"; readonly direct: boolean; readonly changes: ReadonlyArray<readonly [SetupName, Config]> }
  | { readonly kind: "provide"; readonly scope: ScopeName; readonly entries: readonly Entry[] }
  | { readonly kind: "unprovide"; readonly scope: ScopeName; readonly family: Family }
  | { readonly kind: "replace"; readonly family: Family; readonly prev: number }
  | { readonly kind: "dispose-child" }
  | { readonly kind: "create-child" }
  | { readonly kind: "start"; readonly setup: TopName }
  | { readonly kind: "noop" };

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number, steps: number): { inputs: Record<SetupName, Config>; ops: Op[] } {
  const rand = mulberry32(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const entries = (p: number): Entry[] => {
    const chosen = FAMILIES.filter(() => rand() < p).map((family) => ({
      family,
      n: int(2),
      version: int(4),
      descriptor: rand() < 0.5,
    }));
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [chosen[i], chosen[j]] = [chosen[j]!, chosen[i]!];
    }
    return chosen;
  };
  const config = (): Config => {
    const roll = rand();
    return {
      entries: entries(0.35),
      throwAt: roll < 0.12 ? "before" : roll < 0.3 ? "after" : "none",
      nested: rand() < 0.75,
    };
  };
  const inputs = { RS: config(), RN: config(), CS: config(), CN: config() };
  const ops: Op[] = [{ kind: "start", setup: "RS" }, { kind: "create-child" }];
  while (ops.length < steps) {
    const roll = rand();
    if (roll < 0.45) {
      const top = pick(["RS", "CS"] as const);
      const which = rand();
      const names: SetupName[] =
        which < 0.4 ? [top] : which < 0.85 ? [NESTED[top]] : [top, NESTED[top]];
      ops.push({
        kind: "flip",
        direct: names.length === 1 && rand() < 0.3,
        changes: names.map((name) => [name, config()] as const),
      });
    } else if (roll < 0.6) {
      const provided = entries(0.25);
      if (provided.length > 0) ops.push({ kind: "provide", scope: pick(["R", "C"] as const), entries: provided });
    } else if (roll < 0.72) {
      ops.push({ kind: "unprovide", scope: pick(["R", "C"] as const), family: pick(FAMILIES) });
    } else if (roll < 0.82) {
      ops.push({ kind: "replace", family: pick(FAMILIES), prev: int(4) });
    } else if (roll < 0.87) {
      ops.push({ kind: "dispose-child" });
    } else if (roll < 0.93) {
      ops.push({ kind: "create-child" });
    } else if (roll < 0.98) {
      ops.push({ kind: "start", setup: pick(["RS", "CS"] as const) });
    } else {
      ops.push({ kind: "noop" });
    }
  }
  return { inputs, ops };
}

function describeEntries(entries: readonly Entry[]): string {
  return `[${entries.map((e) => (e.family === "Cfg" ? `Cfg(${e.n})` : e.family)).join(",")}]`;
}

function describeConfig(config: Config): string {
  const parts = [describeEntries(config.entries)];
  if (config.throwAt !== "none") parts.push(`throw ${config.throwAt}`);
  if (config.nested) parts.push("nested");
  return parts.join(" ");
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case "flip":
      return `flip${op.direct ? " (direct)" : ""} ${op.changes.map(([name, config]) => `${name}=${describeConfig(config)}`).join("; ")}`;
    case "provide":
      return `provide ${op.scope} ${describeEntries(op.entries)}`;
    case "unprovide":
      return `unprovide ${op.scope} ${op.family}`;
    case "replace":
      return `replace ${op.family}`;
    case "start":
      return `start ${op.setup}`;
    default:
      return op.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// Reference model

interface ModelSetup {
  readonly name: SetupName;
  readonly host: ScopeName;
  owned: Set<Family>;
  children: ModelSetup[];
}

interface ModelInstance {
  readonly token: number;
  readonly deps: readonly string[];
}

interface ModelScope {
  readonly name: ScopeName;
  readonly parent: ModelScope | undefined;
  readonly slots: Map<Family, number>;
  readonly owners: Map<Family, ModelSetup>;
  readonly instances: Map<Family, ModelInstance>;
  readonly dirty: Set<Family>;
}

interface RunResult {
  readonly ok: boolean;
  readonly errors: number;
}

class Model {
  readonly scopes = new Map<ScopeName, ModelScope>();
  readonly top: Partial<Record<TopName, ModelSetup>> = {};
  readonly runs: Record<SetupName, number> = { RS: 0, RN: 0, CS: 0, CN: 0 };
  // Host instance token -> token of the E instance in the scope it created.
  readonly hostE = new Map<number, number>();
  private nextToken = 1;

  constructor(readonly inputs: Record<SetupName, Config>) {
    this.scopes.set("R", this.newScope("R", undefined));
  }

  newScope(name: ScopeName, parent: ModelScope | undefined): ModelScope {
    return { name, parent, slots: new Map(), owners: new Map(), instances: new Map(), dirty: new Set() };
  }

  resolve(scope: ModelScope | undefined, family: Family): ModelScope | undefined {
    for (let s = scope; s !== undefined; s = s.parent) if (s.slots.has(family)) return s;
    return undefined;
  }

  private resolvable(): boolean {
    for (const scope of this.scopes.values()) {
      for (const family of scope.slots.keys()) {
        if (DEPS[family].some((dep) => this.resolve(scope, dep) === undefined)) return false;
      }
    }
    return true;
  }

  private recompute(): void {
    for (const scope of this.scopes.values()) {
      for (const family of FAMILIES) {
        const current = scope.instances.get(family);
        if (!scope.slots.has(family)) {
          if (current !== undefined) this.dropInstance(scope, family);
          continue;
        }
        const deps = DEPS[family].map((dep) => {
          const owner = this.resolve(scope, dep)!;
          return `${owner.name}:${owner.instances.get(dep)!.token}`;
        });
        if (
          current === undefined ||
          scope.dirty.has(family) ||
          deps.some((dep, index) => dep !== current.deps[index])
        ) {
          if (current !== undefined) this.dropInstance(scope, family);
          const token = this.nextToken++;
          scope.instances.set(family, { token, deps });
          if (family === "Host") this.hostE.set(token, this.nextToken++);
        }
      }
      scope.dirty.clear();
    }
  }

  private dropInstance(scope: ModelScope, family: Family): void {
    const instance = scope.instances.get(family)!;
    if (family === "Host") this.hostE.delete(instance.token);
    scope.instances.delete(family);
  }

  provide(scopeName: ScopeName, entries: readonly Entry[], owner: ModelSetup | undefined): boolean {
    const scope = this.scopes.get(scopeName)!;
    const after = new Set([...scope.slots.keys(), ...entries.map((e) => e.family)]);
    for (const entry of entries) {
      if (scope.slots.has(entry.family)) continue;
      for (const dep of DEPS[entry.family]) {
        if (!after.has(dep) && this.resolve(scope.parent, dep) === undefined) return false;
      }
    }
    for (const entry of entries) {
      const n = entry.family === "Cfg" ? entry.n : 0;
      if (scope.slots.get(entry.family) !== n) {
        scope.slots.set(entry.family, n);
        scope.dirty.add(entry.family);
      }
    }
    for (const entry of entries) {
      if (owner === undefined) scope.owners.delete(entry.family);
      else scope.owners.set(entry.family, owner);
    }
    this.recompute();
    return true;
  }

  unprovide(scopeName: ScopeName, family: Family): boolean {
    const scope = this.scopes.get(scopeName)!;
    const n = scope.slots.get(family);
    if (n === undefined) {
      scope.owners.delete(family);
      return true;
    }
    scope.slots.delete(family);
    if (!this.resolvable()) {
      scope.slots.set(family, n);
      return false;
    }
    scope.owners.delete(family);
    this.recompute();
    return true;
  }

  // Releases what each setup still owns; a service that remaining dependents still need stays,
  // owned by `heir`. Returns the number of services that could not be released.
  release(scopeName: ScopeName, candidates: ReadonlyArray<readonly [Family, ModelSetup]>, heir: ModelSetup): number {
    const scope = this.scopes.get(scopeName);
    if (scope === undefined) return 0;
    let queue = [...candidates];
    for (;;) {
      const failed = queue.filter(
        ([family, owner]) => scope.owners.get(family) === owner && !this.unprovide(scopeName, family),
      );
      if (failed.length === 0 || failed.length === queue.length) {
        for (const [family] of failed) {
          scope.owners.set(family, heir);
          heir.owned.add(family);
        }
        return failed.length;
      }
      queue = failed;
    }
  }

  run(record: ModelSetup, first: boolean): RunResult {
    const config = this.inputs[record.name];
    this.runs[record.name]++;
    const stale = record.children;
    record.children = [];
    const collecting = new Set<Family>();
    let ok = config.throwAt !== "before";
    if (ok) {
      for (const entry of config.entries) collecting.add(entry.family);
      ok = this.provide(record.host, config.entries, record);
    }
    if (ok) {
      if (config.nested && (record.name === "RS" || record.name === "CS")) {
        const nested: ModelSetup = {
          name: NESTED[record.name],
          host: record.host,
          owned: new Set(),
          children: [],
        };
        record.children.push(nested);
        if (!this.run(nested, true).ok) record.children.splice(record.children.indexOf(nested), 1);
      }
      ok = config.throwAt !== "after";
    }
    if (ok) {
      const prevOwned = record.owned;
      record.owned = collecting;
      const candidates: Array<readonly [Family, ModelSetup]> = [];
      for (const family of prevOwned) if (!collecting.has(family)) candidates.push([family, record]);
      for (const child of stale) for (const family of child.owned) candidates.push([family, child]);
      return { ok, errors: this.release(record.host, candidates, record) };
    }
    for (const family of collecting) record.owned.add(family);
    const scope = this.scopes.get(record.host)!;
    for (const child of [...stale, ...record.children]) {
      for (const family of child.owned) {
        if (scope.owners.get(family) === child) scope.owners.set(family, record);
        record.owned.add(family);
      }
    }
    record.children = [];
    if (first) {
      this.release(record.host, [...record.owned].map((family) => [family, record] as const), record);
      return { ok, errors: 0 };
    }
    return { ok, errors: 1 };
  }

  start(name: TopName): boolean {
    const record: ModelSetup = { name, host: HOST[name], owned: new Set(), children: [] };
    const { ok } = this.run(record, true);
    if (ok) this.top[name] = record;
    return ok;
  }

  flip(changes: ReadonlyArray<readonly [SetupName, Config]>): number {
    for (const [name, config] of changes) this.inputs[name] = config;
    const changed = new Set(changes.map(([name]) => name));
    let errors = 0;
    for (const top of ["RS", "CS"] as const) {
      const record = this.top[top];
      if (record === undefined) continue;
      if (changed.has(top)) {
        errors += this.run(record, false).errors;
      } else if (changed.has(NESTED[top]) && record.children.length > 0) {
        errors += this.run(record.children[0]!, false).errors;
      }
    }
    return errors;
  }

  replace(family: Family): number {
    let count = 0;
    for (const scope of this.scopes.values()) {
      if (scope.slots.has(family)) {
        scope.dirty.add(family);
        count++;
      }
    }
    if (family === "E") {
      for (const host of this.hostE.keys()) {
        this.hostE.set(host, this.nextToken++);
        count++;
      }
    }
    this.recompute();
    return count;
  }

  disposeChild(): void {
    const child = this.scopes.get("C")!;
    const host = child.instances.get("Host");
    if (host !== undefined) this.hostE.delete(host.token);
    this.scopes.delete("C");
    delete this.top.CS;
  }

  createChild(): boolean {
    this.scopes.set("C", this.newScope("C", this.scopes.get("R")));
    return this.start("CS");
  }
}

// ---------------------------------------------------------------------------------------------
// Implementation under test

interface Tracked {
  readonly object: Record<string, unknown>;
  disposed: number;
}

class World {
  readonly root: Scope = createRootScope({ id: "model-root" });
  child: Scope | undefined;
  readonly versions = {} as Record<Family, Array<new (...args: any[]) => any>>;
  readonly inputs: Record<SetupName, ShallowRef<Config>>;
  readonly runs: Record<SetupName, number> = { RS: 0, RN: 0, CS: 0, CN: 0 };
  readonly tracked: Tracked[] = [];

  constructor(inputs: Record<SetupName, Config>) {
    for (const family of FAMILIES) this.versions[family] = [this.makeVersion(family, 0)];
    this.inputs = {
      RS: shallowRef(inputs.RS),
      RN: shallowRef(inputs.RN),
      CS: shallowRef(inputs.CS),
      CN: shallowRef(inputs.CN),
    };
  }

  base(family: Family): new (...args: any[]) => any {
    return this.versions[family][0]!;
  }

  makeVersion(family: Family, version: number): new (...args: any[]) => any {
    const world = this;
    const cls = class {
      [key: string]: unknown;
      constructor(arg?: { readonly n: number }) {
        for (const dep of DEPS[family]) this[dep] = inject(world.base(dep));
        if (family === "Cfg") this.n = arg!.n;
        if (family === "Host") {
          const child = inject(CurrentScope).createChild();
          child.provide(world.base("E"));
          this.child = child;
          onScopeDispose(() => child.dispose());
        }
        const tracked: Tracked = { object: this, disposed: 0 };
        world.tracked.push(tracked);
        onScopeDispose(() => tracked.disposed++);
      }
    };
    Object.defineProperty(cls, "name", { value: `${family}${version}` });
    return cls;
  }

  entry(entry: Entry): any {
    const versions = this.versions[entry.family];
    const cls = versions[entry.version % versions.length]!;
    if (entry.family === "Cfg") return createDescriptor(cls, { n: entry.n });
    return entry.descriptor ? createDescriptor(cls) : cls;
  }

  setupFn(name: SetupName): () => void {
    return () => {
      const config = this.inputs[name].value;
      this.runs[name]++;
      if (config.throwAt === "before") throw new Error(`${name} failed before providing`);
      useServices(config.entries.map((entry) => this.entry(entry)));
      if (config.nested && (name === "RS" || name === "CS")) {
        try {
          useSetup(this.setupFn(NESTED[name]));
        } catch {}
      }
      if (config.throwAt === "after") throw new Error(`${name} failed after providing`);
    };
  }

  start(name: TopName): boolean {
    const scope = name === "RS" ? this.root : this.child!;
    try {
      scope.setup(this.setupFn(name));
      return true;
    } catch {
      return false;
    }
  }

  scope(name: ScopeName): Scope {
    return name === "R" ? this.root : this.child!;
  }
}

// ---------------------------------------------------------------------------------------------
// Runner

class Divergence extends Error {}

function diverge(message: string): never {
  throw new Divergence(message);
}

function runSequence(inputs: Record<SetupName, Config>, ops: readonly Op[]): { step: number; message: string } | undefined {
  const model = new Model({ ...inputs });
  const world = new World(inputs);
  const tokenToObject = new Map<number, object>();
  const objectToToken = new Map<object, number>();
  let step = 0;

  const identify = (token: number, object: object, what: string): void => {
    const known = tokenToObject.get(token);
    if (known !== undefined) {
      if (known !== object) diverge(`${what}: expected the instance to be kept, got a new one`);
      return;
    }
    if (objectToToken.has(object)) diverge(`${what}: expected a new instance, got the previous one`);
    tokenToObject.set(token, object);
    objectToToken.set(object, token);
  };

  const check = (): void => {
    const live = new Set<object>();
    for (const name of ["R", "C"] as const) {
      const modelScope = model.scopes.get(name);
      if ((modelScope === undefined) !== (name === "C" && world.child === undefined)) {
        diverge(`scope ${name} liveness differs`);
      }
      if (modelScope === undefined) continue;
      const scope = world.scope(name);
      for (const family of FAMILIES) {
        const id = world.base(family);
        const provided = scope.getDescriptor(id) !== undefined;
        if (provided !== modelScope.slots.has(family)) {
          diverge(`provided: ${name}.${family} expected ${modelScope.slots.has(family)}, got ${provided}`);
        }
        if (!provided) continue;
        let object: Record<string, unknown>;
        try {
          object = scope.get(id);
        } catch (error) {
          diverge(`get ${name}.${family} threw: ${String(error)}`);
        }
        const instance = modelScope.instances.get(family)!;
        identify(instance.token, object, `instance ${name}.${family}`);
        live.add(object);
        if (object.constructor !== world.versions[family].at(-1)) {
          diverge(`instance ${name}.${family} is not of the latest version`);
        }
        if (family === "Cfg" && object.n !== modelScope.slots.get("Cfg")) {
          diverge(`instance ${name}.Cfg has n=${String(object.n)}, expected ${modelScope.slots.get("Cfg")}`);
        }
        for (const dep of DEPS[family]) {
          const owner = model.resolve(modelScope, dep)!;
          if (object[dep] !== tokenToObject.get(owner.instances.get(dep)!.token)) {
            diverge(`instance ${name}.${family} holds a stale ${dep}`);
          }
        }
        if (family === "Host") {
          const child = object.child as Scope;
          if (child.isDisposed) diverge(`scope created by ${name}.Host is disposed`);
          let e: object;
          try {
            e = child.get(world.base("E"));
          } catch (error) {
            diverge(`E in the scope created by ${name}.Host: ${String(error)}`);
          }
          identify(model.hostE.get(instance.token)!, e, `instance E in the scope created by ${name}.Host`);
          live.add(e);
        }
      }
    }
    for (const tracked of world.tracked) {
      const expected = live.has(tracked.object) ? 0 : 1;
      if (tracked.disposed !== expected) {
        diverge(
          `disposal: ${tracked.object.constructor.name} disposed ${tracked.disposed} times, expected ${expected}`,
        );
      }
    }
    for (const name of ["RS", "RN", "CS", "CN"] as const) {
      if (world.runs[name] !== model.runs[name]) {
        diverge(`runs: ${name} ran ${world.runs[name]} times, expected ${model.runs[name]}`);
      }
    }
    const idle = batchScopeUpdates(() => {});
    if (idle.length > 0) diverge(`an empty batch reported ${idle.length} errors: ${String(idle[0])}`);
  };

  const expectThrow = (expected: boolean, fn: () => void, what: string): void => {
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error ?? new Error("undefined");
    }
    if ((thrown !== undefined) !== expected) {
      diverge(`errors: ${what} ${expected ? "should throw" : `threw ${String(thrown)}`}`);
    }
  };

  try {
    for (; step < ops.length; step++) {
      const op = ops[step]!;
      switch (op.kind) {
        case "flip": {
          const expected = model.flip(op.changes);
          if (op.direct && expected === 0) {
            expectThrow(false, () => {
              for (const [name, config] of op.changes) world.inputs[name].value = config;
            }, "flip");
          } else {
            const errors = batchScopeUpdates(() => {
              for (const [name, config] of op.changes) world.inputs[name].value = config;
            });
            if (errors.length !== expected) {
              diverge(`errors: flip reported ${errors.length} errors (${errors.map(String).join(" | ")}), expected ${expected}`);
            }
          }
          break;
        }
        case "provide": {
          if (!model.scopes.has(op.scope)) break;
          const ok = model.provide(op.scope, op.entries, undefined);
          expectThrow(!ok, () => world.scope(op.scope).provideAll(op.entries.map((e) => world.entry(e))), "provide");
          break;
        }
        case "unprovide": {
          if (!model.scopes.has(op.scope)) break;
          const ok = model.unprovide(op.scope, op.family);
          expectThrow(!ok, () => world.scope(op.scope).unprovide(world.base(op.family)), "unprovide");
          break;
        }
        case "replace": {
          const versions = world.versions[op.family];
          const next = world.makeVersion(op.family, versions.length);
          const prev = versions[op.prev % versions.length]!;
          versions.push(next);
          const expected = model.replace(op.family);
          let replaced = -1;
          expectThrow(false, () => (replaced = replaceService(prev, next)), "replaceService");
          if (replaced !== expected) diverge(`replaceService replaced ${replaced} registrations, expected ${expected}`);
          break;
        }
        case "dispose-child": {
          if (!model.scopes.has("C")) break;
          model.disposeChild();
          expectThrow(false, () => world.child!.dispose(), "dispose child");
          world.child = undefined;
          break;
        }
        case "create-child": {
          if (model.scopes.has("C")) break;
          const ok = model.createChild();
          world.child = world.root.createChild({ id: "child" });
          if (world.start("CS") !== ok) diverge(`errors: child setup first run ${ok ? "should succeed" : "should fail"}`);
          break;
        }
        case "start": {
          if (model.top[op.setup] !== undefined || !model.scopes.has(HOST[op.setup])) break;
          const ok = model.start(op.setup);
          if (world.start(op.setup) !== ok) diverge(`errors: ${op.setup} first run ${ok ? "should succeed" : "should fail"}`);
          break;
        }
        case "noop":
          break;
      }
      check();
    }
    world.root.dispose();
    for (const tracked of world.tracked) {
      if (tracked.disposed !== 1) {
        diverge(`final disposal: ${tracked.object.constructor.name} disposed ${tracked.disposed} times`);
      }
    }
    return undefined;
  } catch (error) {
    if (!world.root.isDisposed) {
      try {
        world.root.dispose();
      } catch {}
    }
    const message = error instanceof Divergence ? error.message : `unexpected: ${String((error as Error)?.stack ?? error)}`;
    return { step, message };
  }
}

function category(message: string): string {
  return message.split(":")[0]!;
}

function shrink(inputs: Record<SetupName, Config>, ops: readonly Op[], failure: { step: number; message: string }) {
  let current = ops.slice(0, failure.step + 1);
  let currentFailure = failure;
  const kind = category(failure.message);
  let budget = 400;
  for (let changed = true; changed && budget > 0; ) {
    changed = false;
    for (let i = current.length - 1; i >= 0 && budget > 0; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      budget--;
      const result = runSequence(inputs, candidate);
      if (result !== undefined && category(result.message) === kind) {
        current = candidate.slice(0, result.step + 1);
        currentFailure = result;
        changed = true;
        i = Math.min(i, current.length);
      }
    }
  }
  return { ops: current, failure: currentFailure };
}

describe("setup ownership model", () => {
  it.each(SEEDS)("seed %i", (seed) => {
    const { inputs, ops } = generate(seed, STEPS);
    const failure = runSequence(inputs, ops);
    if (failure === undefined) return;
    const shrunk = shrink(inputs, ops, failure);
    const lines = [
      `seed ${seed} diverged at step ${failure.step}: ${failure.message}`,
      `shrunk to ${shrunk.ops.length} steps, failing at step ${shrunk.failure.step}: ${shrunk.failure.message}`,
      `initial inputs: ${(["RS", "RN", "CS", "CN"] as const).map((name) => `${name}=${describeConfig(inputs[name])}`).join("; ")}`,
      ...shrunk.ops.map((op, index) => `  ${index}: ${describeOp(op)}`),
    ];
    expect.fail(lines.join("\n"));
  });
});
