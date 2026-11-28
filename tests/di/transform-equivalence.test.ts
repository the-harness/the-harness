import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transformWithOxc } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { transformHotModule } from "../../packages/di/src/vite.ts";

interface Case {
  readonly name: string;
  // Each case runs `main.mjs` and compares its awaited default export.
  readonly files: Readonly<Record<string, string>>;
  // Files `transformHotModule` must leave alone; every other file must be transformed.
  readonly untransformed?: readonly string[];
  // Sources use legacy decorators and are compiled by oxc before the HMR transform.
  readonly decorators?: boolean;
  readonly throws?: boolean;
}

const src = (...lines: string[]) => lines.join("\n");

const cases: readonly Case[] = [
  {
    name: "function, async, generator and async generator declarations",
    files: {
      "a.mjs": src(
        "export function plain(x) { return x * 2; }",
        "export async function asyncFn(x) { return x + 1; }",
        "export function* gen(n) { for (let i = 0; i < n; i++) yield i; }",
        "export async function* asyncGen(n) { for (let i = 0; i < n; i++) yield i * 10; }",
      ),
      "main.mjs": src(
        `import { plain, asyncFn, gen, asyncGen } from "./a.mjs";`,
        "const kinds = [plain, asyncFn, gen, asyncGen].map((f) => [f.name, f.length, Object.prototype.toString.call(f), Object.getPrototypeOf(f).constructor.name]);",
        "export default (async () => {",
        "  const collected = [];",
        "  for await (const value of asyncGen(3)) collected.push(value);",
        "  return { kinds, plain: plain(2), async: await asyncFn(1), gen: [...gen(3)], collected, promise: asyncFn(0) instanceof Promise };",
        "})();",
      ),
    },
  },
  {
    name: "const, let and var function variables",
    files: {
      "a.mjs": src(
        "export const arrow = (a, b) => a + b;",
        "export const expr = function (a) { return a; };",
        "export const named = function inner(a, b, c) { return inner.name; };",
        `export let letArrow = () => "let";`,
        `export var varArrow = async () => "var";`,
        "export const first = () => 1, second = function () { return 2; }, third = 3, fourth = function* () { yield 4; };",
      ),
      "main.mjs": src(
        `import * as a from "./a.mjs";`,
        "const fns = [a.arrow, a.expr, a.named, a.letArrow, a.varArrow, a.first, a.second, a.fourth];",
        "export default (async () => ({",
        "  meta: fns.map((f) => [f.name, f.length, Object.getPrototypeOf(f).constructor.name]),",
        "  results: [a.arrow(1, 2), a.expr(3), a.named(), a.letArrow(), await a.varArrow(), a.first(), a.second(), a.third, [...a.fourth()]],",
        "}))();",
      ),
    },
  },
  {
    name: "export specifiers with aliases and string names",
    files: {
      "a.mjs": src(
        `function a() { return "a"; }`,
        "const b = 2;",
        `class C { static id = "C"; }`,
        `export { a as alias, b as "string name", C as "class-name", a };`,
        "export { b as default };",
      ),
      "main.mjs": src(
        `import * as ns from "./a.mjs";`,
        `import def, { alias, a, "string name" as str, "class-name" as Cls } from "./a.mjs";`,
        "export default {",
        "  keys: Object.keys(ns),",
        "  same: alias === a,",
        "  alias: [alias.name, alias()],",
        "  str, def, cls: [Cls.name, Cls.id],",
        "};",
      ),
    },
  },
  {
    name: "default exports of named and anonymous functions and classes",
    files: {
      "named-fn.mjs": src(
        "export default function named(x) { return x + 1; }",
        "export const viaLocal = () => named(1);",
      ),
      "anon-fn.mjs": "export default function (x) { return x * 3; }",
      "named-class.mjs": src(
        "export default class Named { static make() { return new Named(); } }",
        "export const instance = new Named();",
      ),
      "anon-class.mjs": "export default class { get value() { return 1; } }",
      "arrow.mjs": "export default (x) => x - 1;",
      "async-gen.mjs": "export default async function* () { yield 1; }",
      "main.mjs": src(
        `import namedFn, { viaLocal } from "./named-fn.mjs";`,
        `import anonFn from "./anon-fn.mjs";`,
        `import NamedClass, { instance } from "./named-class.mjs";`,
        `import AnonClass from "./anon-class.mjs";`,
        `import arrow from "./arrow.mjs";`,
        `import asyncGen from "./async-gen.mjs";`,
        "export default (async () => ({",
        "  names: [namedFn, anonFn, NamedClass, AnonClass, arrow, asyncGen].map((f) => [f.name, f.length]),",
        "  results: [namedFn(1), viaLocal(), anonFn(2), NamedClass.make() instanceof NamedClass, instance instanceof NamedClass, new AnonClass().value, arrow(5)],",
        "  gen: (await asyncGen().next()).value,",
        "}))();",
      ),
    },
  },
  {
    name: "export star, export star as and re-exports from sources",
    files: {
      "b.mjs": src(
        "export const one = 1;",
        "export function two() { return 2; }",
        `const s = "S";`,
        `export { s as "str" };`,
        `export default "b-default";`,
      ),
      "c.mjs": src(`export const x = "x";`, `export default "c-default";`),
      "a.mjs": src(
        `export * from "./b.mjs";`,
        `export * as ns from "./c.mjs";`,
        `export { x as y } from "./c.mjs";`,
        `export { "str" as plainName, default } from "./b.mjs";`,
        `export { default as cDefault } from "./c.mjs";`,
      ),
      "main.mjs": src(
        `import * as a from "./a.mjs";`,
        "export default {",
        "  keys: Object.keys(a),",
        "  nsKeys: Object.keys(a.ns),",
        "  values: [a.one, a.two(), a.str, a.y, a.plainName, a.default, a.cDefault, a.ns.x, a.ns.default],",
        "};",
      ),
    },
  },
  {
    name: "re-exports of imported bindings",
    files: {
      "b.mjs": src(
        `export function f() { return "f"; }`,
        "export class V {}",
        "export default 42;",
      ),
      "a.mjs": src(
        `import { f, V } from "./b.mjs";`,
        `import * as all from "./b.mjs";`,
        `import def from "./b.mjs";`,
        "export { f, V as Value, all, def as defaultOfB };",
      ),
      "main.mjs": src(
        `import * as b from "./b.mjs";`,
        `import { f, Value, all, defaultOfB } from "./a.mjs";`,
        "export default { same: [f === b.f, Value === b.V, all === b], f: f(), defaultOfB, keys: Object.keys(all) };",
      ),
    },
  },
  {
    name: "destructuring exports",
    files: {
      "a.mjs": src(
        "const source = { a: 1, nested: { b: [2, 3, 4] }, r1: 5, r2: 6 };",
        "export const { a, nested: { b: [b0, ...bRest] }, ...rest } = source;",
        "export let [x = 10, , y] = [undefined, 0, 7];",
        `export const { fn = () => "default fn" } = {};`,
      ),
      "main.mjs": src(
        `import * as m from "./a.mjs";`,
        "export default { keys: Object.keys(m), a: m.a, b0: m.b0, bRest: m.bRest, rest: m.rest, x: m.x, y: m.y, fn: [m.fn.name, m.fn()] };",
      ),
    },
  },
  {
    name: "exported let reassigned later",
    files: {
      "a.mjs": src(
        "export let count = 0;",
        "export function increment() { count++; return count; }",
        `export let later = () => "first";`,
        `export function swap() { later = () => "second"; }`,
        "export let assignedAtTop = 1;",
        "assignedAtTop = 2;",
      ),
      "main.mjs": src(
        `import { count, increment, later, swap, assignedAtTop } from "./a.mjs";`,
        "const before = [count, later()];",
        "increment(); increment(); swap();",
        "export default { before, after: [count, later(), later.name], assignedAtTop };",
      ),
    },
  },
  {
    name: "class declarations, expressions, static fields and private members",
    files: {
      "a.mjs": src(
        `export function make() { return "made"; }`,
        "export class A {",
        "  #secret = 1;",
        "  static #count = 0;",
        "  static helper = make;",
        "  static created = make();",
        "  getSecret() { return this.#secret; }",
        "  static has(o) { return #secret in o; }",
        "  static bump() { return ++A.#count; }",
        "}",
        `export const B = class extends A { kind() { return "B"; } };`,
        "export const Named = class Inner { static self() { return Inner === Named; } };",
        "export let L = class {}, notClass = 1;",
        "export var V = class { static ref = () => V; };",
        "class Local { static tag = A.created; }",
        "export { Local as Exposed };",
      ),
      "main.mjs": src(
        `import { A, B, Named, L, V, Exposed, make, notClass } from "./a.mjs";`,
        "const b = new B();",
        "export default {",
        "  names: [A.name, B.name, Named.name, L.name, V.name, Exposed.name],",
        "  statics: [A.helper === make, A.created, A.bump(), A.bump(), Exposed.tag],",
        "  privates: [b.getSecret(), A.has(b), A.has({})],",
        "  misc: [b.kind(), b instanceof A, Named.self(), V.ref() === V, notClass],",
        "};",
      ),
    },
  },
  {
    name: "const class bindings stay read-only",
    files: {
      "a.mjs": src(
        "export const K = class {};",
        "const Hidden = class {};",
        "export function assignK() { try { K = 1; return typeof K; } catch (e) { return e.constructor.name; } }",
        "export function assignHidden() { try { Hidden = 1; return typeof Hidden; } catch (e) { return e.constructor.name; } }",
      ),
      "main.mjs": src(
        `import { assignK, assignHidden } from "./a.mjs";`,
        "export default [assignK(), assignHidden()];",
      ),
    },
  },
  {
    name: "legacy-decorated classes and methods",
    decorators: true,
    files: {
      "a.mjs": src(
        "const log = [];",
        "function tag(value) {",
        "  return (cls) => {",
        "    log.push(`class:${cls.name}`);",
        "    const Wrapped = class extends cls { static tag = value; };",
        "    return Wrapped;",
        "  };",
        "}",
        "function method(target, key, descriptor) {",
        "  log.push(`method:${String(key)}`);",
        "  const original = descriptor.value;",
        "  descriptor.value = function (...args) { return `decorated:${original.apply(this, args)}`; };",
        "  return descriptor;",
        "}",
        `@tag("t1")`,
        "export class Service {",
        "  @method greet(name) { return `hi ${name}`; }",
        "  static make() { return new Service(); }",
        "}",
        `@tag("t2")`,
        "class Local {",
        "  @method static hello() { return \"local\"; }",
        "}",
        "export { Local as Exposed };",
        "export const decoratedLog = log;",
        "export const instance = new Service();",
        "export function create() { return new Service(); }",
      ),
      "main.mjs": src(
        `import { Service, Exposed, decoratedLog, instance, create } from "./a.mjs";`,
        "export default {",
        "  log: decoratedLog,",
        "  tags: [Service.tag, Exposed.tag, Service.name, Exposed.name],",
        `  calls: [instance.greet("a"), create().greet("b"), Service.make().greet("c"), Exposed.hello()],`,
        "  identity: [instance instanceof Service, create() instanceof Service, Service.make() instanceof Service],",
        "};",
      ),
    },
  },
  {
    name: "top-level new of exported classes",
    files: {
      "a.mjs": src(
        "export class Counter { static instances = 0; constructor() { Counter.instances++; } }",
        "export const first = new Counter();",
        "export const second = new Counter();",
        "export const E = class { constructor() { this.self = E; } };",
        "export const e = new E();",
        "export default new (class Anonymous { value = 7; })();",
      ),
      "main.mjs": src(
        `import def, { Counter, first, second, E, e } from "./a.mjs";`,
        "export default {",
        "  instances: Counter.instances,",
        "  identity: [first instanceof Counter, second.constructor === Counter, e instanceof E, e.self === E],",
        "  def: [def.value, def.constructor.name],",
        "};",
      ),
    },
  },
  {
    name: "functions used before their declaration",
    files: {
      "a.mjs": src(
        "export const early = useLater(2);",
        "export const earlyName = useLater.name;",
        "export const earlyVar = typeof lateVar;",
        "export const callVarEarly = (() => { try { return lateVar(); } catch (e) { return e.constructor.name; } })();",
        "export const classEarly = (() => { try { return typeof Later; } catch (e) { return e.constructor.name; } })();",
        "export function useLater(x) { return helper(x) * 2; }",
        "function helper(x) { return x + 1; }",
        "export var lateVar = () => 1;",
        "export class Later {}",
      ),
      "main.mjs": src(
        `import * as a from "./a.mjs";`,
        "export default { early: a.early, earlyName: a.earlyName, earlyVar: a.earlyVar, callVarEarly: a.callVarEarly, classEarly: a.classEarly, late: a.lateVar() };",
      ),
    },
  },
  {
    name: "functions with properties and ES5 constructors",
    files: {
      "a.mjs": src(
        "export function withProps() { return withProps.counter; }",
        "withProps.counter = 5;",
        "export function Animal(name) { this.name = name; }",
        `Animal.prototype.speak = function () { return this.name + " speaks"; };`,
        "export function Dog(name) { Animal.call(this, name); }",
        "Dog.prototype = Object.create(Animal.prototype);",
        "Dog.prototype.constructor = Dog;",
        `Dog.prototype.fetch = function () { return this.name + " fetches"; };`,
        "export function defined() {}",
        `Object.defineProperty(defined, "tag", { value: "t" });`,
        "export const arrowWithProp = () => arrowWithProp.extra;",
        `arrowWithProp.extra = "x";`,
        "export function Assigned() {}",
        "Object.assign(Assigned.prototype, { hi() { return \"hi\"; } });",
      ),
      "main.mjs": src(
        `import { withProps, Animal, Dog, defined, arrowWithProp, Assigned } from "./a.mjs";`,
        `const dog = new Dog("rex");`,
        "export default {",
        "  values: [withProps(), defined.tag, arrowWithProp(), new Assigned().hi()],",
        "  dog: [dog.speak(), dog.fetch(), dog instanceof Dog, dog instanceof Animal, dog.constructor === Dog],",
        "  protos: [Object.getPrototypeOf(Dog.prototype) === Animal.prototype, Object.keys(Animal.prototype)],",
        "};",
      ),
    },
  },
  {
    name: "this, new.target and arguments in exported functions",
    files: {
      "a.mjs": src(
        `export function whoAmI() { return this === undefined ? "undefined" : this.label; }`,
        "export function targetOf() { return new.target === undefined ? \"call\" : new.target === targetOf ? \"self\" : new.target.name; }",
        "export function Recorder() { this.target = new.target === Recorder ? \"self\" : new.target?.name; }",
        "export function argList() { return [arguments.length, ...arguments]; }",
        "export const exprThis = function () { return this?.label ?? \"none\"; };",
        "export const arrowArgs = (...rest) => rest.length;",
        `export function Ctor(x) { if (!new.target) return "called"; this.x = x; }`,
      ),
      "main.mjs": src(
        `import { whoAmI, targetOf, Recorder, argList, exprThis, arrowArgs, Ctor } from "./a.mjs";`,
        "class Sub extends Recorder {}",
        "class Other {}",
        "export default {",
        `  thisValues: [whoAmI(), whoAmI.call({ label: "obj" }), exprThis(), exprThis.call({ label: "e" }), ({ label: "m", whoAmI }).whoAmI()],`,
        "  targets: [targetOf(), new Recorder().target, new Sub().target, Reflect.construct(Recorder, [], Other).target, Ctor(1), new Ctor(2).x, new Ctor(3) instanceof Ctor],",
        "  args: [argList(1, 2, 3), argList.apply(null, [4]), arrowArgs(1, 2)],",
        "};",
      ),
    },
  },
  {
    name: "namespace objects and their getters",
    files: {
      "a.mjs": src(
        "export let count = 0;",
        "export function bump() { return ++count; }",
        "export const value = { nested: true };",
        "export class K {}",
        "export default function () {}",
      ),
      "main.mjs": src(
        `import * as ns from "./a.mjs";`,
        "const describe = (key) => {",
        "  const d = Object.getOwnPropertyDescriptor(ns, key);",
        "  return d && { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable, type: typeof d.value };",
        "};",
        "const before = ns.count;",
        "ns.bump();",
        "export default {",
        "  keys: Object.keys(ns),",
        "  names: Object.getOwnPropertyNames(ns),",
        "  tag: ns[Symbol.toStringTag],",
        "  extensible: Object.isExtensible(ns),",
        "  descriptors: Object.keys(ns).map(describe),",
        "  live: [before, ns.count],",
        // Spelled apart: the transform skips sources that mention its own identifiers.
        `  hidden: Object.getOwnPropertyNames(ns).filter((key) => key.startsWith("__harness" + "_hmr")),`,
        "  write: (() => { try { ns.count = 9; return \"written\"; } catch (e) { return e.constructor.name; } })(),",
        "};",
      ),
    },
  },
  {
    name: "shadowed names",
    files: {
      "a.mjs": src(
        `export function f() { return "outer"; }`,
        `export const g = () => "g";`,
        "export class K { static v = 1; }",
        `export function shadowFunction() { function f() { return "inner"; } return f(); }`,
        "export function shadowParam(f) { return f; }",
        `export function shadowBlock() { { const g = "block"; return g; } }`,
        "export function shadowClass() { class K { static v = 2; } return K.v; }",
        `export function shadowCatch() { try { throw "caught"; } catch (f) { return f; } }`,
        "export function shadowAssign() { let g = 1; g = 2; return g; }",
        "export function shadowProps() { const f = {}; f.x = 1; return f.x; }",
        "export function usesOuter() { return [f(), g(), K.v]; }",
      ),
      "main.mjs": src(
        `import * as a from "./a.mjs";`,
        `export default [a.f(), a.g(), a.K.v, a.shadowFunction(), a.shadowParam("p"), a.shadowBlock(), a.shadowClass(), a.shadowCatch(), a.shadowAssign(), a.shadowProps(), a.usesOuter()];`,
      ),
    },
  },
  {
    name: "import cycle reading an uninitialized binding throws",
    throws: true,
    files: {
      "a.mjs": src(`import "./b.mjs";`, "export const aValue = 1;"),
      "b.mjs": src(`import { aValue } from "./a.mjs";`, "export const seen = aValue + 1;"),
      "main.mjs": src(`import { aValue } from "./a.mjs";`, "export default aValue;"),
    },
  },
  {
    name: "import cycle calling a hoisted function before its module runs",
    files: {
      "a.mjs": src(
        `import { fromB } from "./b.mjs";`,
        `export function hoisted() { return "hoisted"; }`,
        "export const seen = fromB;",
      ),
      "b.mjs": src(
        `import { hoisted } from "./a.mjs";`,
        "export const fromB = hoisted();",
        "export const name = hoisted.name;",
      ),
      "main.mjs": src(
        `import { seen } from "./a.mjs";`,
        `import { name } from "./b.mjs";`,
        "export default [seen, name];",
      ),
    },
  },
  {
    name: "import cycle with classes used lazily",
    files: {
      "a.mjs": src(
        `import { B } from "./b.mjs";`,
        "export class A { b() { return new B(); } }",
      ),
      "b.mjs": src(
        `import { A } from "./a.mjs";`,
        "export class B { a() { return new A(); } }",
        "export function isA(value) { return value instanceof A; }",
      ),
      "main.mjs": src(
        `import { A } from "./a.mjs";`,
        `import { B, isA } from "./b.mjs";`,
        "export default [new A().b() instanceof B, isA(new B().a())];",
      ),
    },
  },
  {
    name: "import cycle re-exporting an uninitialized imported binding",
    files: {
      "a.mjs": src(
        `import { B } from "./b.mjs";`,
        "export { B as ReB };",
        "export function useB() { return new B().kind; }",
      ),
      "b.mjs": src(`import "./a.mjs";`, `export class B { kind = "b"; }`),
      "main.mjs": src(
        `import { B } from "./b.mjs";`,
        `import { ReB, useB } from "./a.mjs";`,
        "export default [ReB === B, useB()];",
      ),
    },
  },
  {
    name: "import cycle through a barrel",
    files: {
      "index.mjs": src(`export * from "./window.mjs";`, `export * from "./doc.mjs";`),
      "doc.mjs": "export class Doc {}",
      "window.mjs": src(
        `import { Doc } from "./index.mjs";`,
        "export function describe(value) { return value instanceof Doc; }",
      ),
      "main.mjs": src(`import { Doc, describe } from "./index.mjs";`, "export default describe(new Doc());"),
    },
  },
  {
    name: "import.meta.url use",
    files: {
      "a.mjs": src(
        `export const endsWith = import.meta.url.endsWith("/a.mjs");`,
        `export function sibling() { return new URL("./x.txt", import.meta.url).pathname.endsWith("/x.txt"); }`,
        "export const dirname = typeof import.meta.dirname;",
      ),
      "meta-object.mjs": "export const hasUrl = Object.keys(import.meta).includes(\"url\");",
      "meta-hot.mjs": "export const noHot = import.meta.hot === undefined;",
      "main.mjs": src(
        `import { endsWith, sibling, dirname } from "./a.mjs";`,
        `import { hasUrl } from "./meta-object.mjs";`,
        `import { noHot } from "./meta-hot.mjs";`,
        "export default [endsWith, sibling(), dirname, hasUrl, noHot];",
      ),
    },
    untransformed: ["meta-object.mjs", "meta-hot.mjs"],
  },
  {
    name: "top-level await and modules without exports",
    files: {
      "await.mjs": "export const awaited = await Promise.resolve(1);",
      "for-await.mjs": src(
        "export const items = [];",
        "for await (const item of [Promise.resolve(2)]) items.push(item);",
      ),
      "log.mjs": "export const log = [];",
      "side-effect.mjs": src(`import { log } from "./log.mjs";`, `log.push("side effect");`),
      "main.mjs": src(
        `import { awaited } from "./await.mjs";`,
        `import { items } from "./for-await.mjs";`,
        `import { log } from "./log.mjs";`,
        `import "./side-effect.mjs";`,
        "export default [awaited, items, log];",
      ),
    },
    untransformed: ["await.mjs", "for-await.mjs", "side-effect.mjs"],
  },
  {
    name: "named function expressions referring to themselves",
    files: {
      "a.mjs": src(
        "export const cb = function named() { return named; };",
        "export const fact = function f(n) { return n <= 1 ? 1 : n * f(n - 1); };",
      ),
      "main.mjs": src(
        `import { cb, fact } from "./a.mjs";`,
        "export default { self: cb() === cb, name: cb.name, fact: fact(5) };",
      ),
    },
  },
  {
    name: "arrow, async and method-like exports are not constructible",
    files: {
      "a.mjs": src(
        "export const arrow = () => 1;",
        "export const asyncArrow = async () => 1;",
        "export async function asyncFn() {}",
        "export const method = { m() {} }.m;",
        "export function plain() {}",
      ),
      "main.mjs": src(
        `import * as a from "./a.mjs";`,
        "const isConstructor = (f) => { try { Reflect.construct(String, [], f); return true; } catch { return false; } };",
        "const construct = (f) => { try { new f(); return \"constructed\"; } catch (e) { return e.constructor.name; } };",
        "const fns = [a.arrow, a.asyncArrow, a.asyncFn, a.method, a.plain];",
        "export default fns.map((f) => [f.name, Object.hasOwn(f, \"prototype\"), isConstructor(f), construct(f), Object.getOwnPropertyNames(f).sort()]);",
      ),
    },
  },
  {
    name: "length and name of exported functions",
    files: {
      "a.mjs": src(
        "export function defaults(a, b = 1, c) {}",
        "export function rest(a, ...more) {}",
        "export const destructured = ({ a }, [b]) => {};",
        "export const anonymous = function () {};",
        "export const arrow = (x, y) => {};",
        "export default function (a, b, c) {}",
      ),
      "main.mjs": src(
        `import def, * as a from "./a.mjs";`,
        "const describe = (f) => [\"length\", \"name\"].map((key) => {",
        "  const d = Object.getOwnPropertyDescriptor(f, key);",
        "  return [d.value, d.writable, d.enumerable, d.configurable];",
        "});",
        "export default [a.defaults, a.rest, a.destructured, a.anonymous, a.arrow, def].map(describe);",
      ),
    },
  },
  {
    name: "exported functions borrowed as methods",
    files: {
      "a.mjs": src(
        "export function getLabel() { return this?.label; }",
        "export const exprLabel = function () { return this?.label; };",
        "export function chain() { return this; }",
        "export function setLabel(value) { this.label = value; return this; }",
      ),
      "main.mjs": src(
        `import { getLabel, exprLabel, chain, setLabel } from "./a.mjs";`,
        `const obj = { label: "obj", getLabel, exprLabel, chain, setLabel };`,
        "class Host { constructor() { this.label = \"host\"; } }",
        "Host.prototype.getLabel = getLabel;",
        "export default {",
        `  methods: [obj.getLabel(), obj.exprLabel(), obj.chain() === obj, obj.setLabel("set").label, new Host().getLabel()],`,
        `  bound: [getLabel.bind({ label: "bound" })(), getLabel.call(7) === undefined, chain.call(7), typeof chain.call("s")],`,
        "};",
      ),
    },
  },
  {
    name: "generator and async function objects",
    files: {
      "a.mjs": src(
        "export function* gen() { yield 1; }",
        "export const genExpr = function* () { yield 2; };",
        "export async function asyncFn() { return 3; }",
        "export async function* asyncGen() { yield 4; }",
      ),
      "main.mjs": src(
        `import { gen, genExpr, asyncFn, asyncGen } from "./a.mjs";`,
        "const kinds = [gen, genExpr, asyncFn, asyncGen];",
        "export default (async () => ({",
        "  protos: [gen, genExpr, asyncGen].map((f) => [Object.getPrototypeOf(f()) === f.prototype, f() instanceof f, Object.getOwnPropertyDescriptor(f, \"prototype\")?.writable]),",
        "  ctor: kinds.map((f) => [Object.getPrototypeOf(f) === Object.getPrototypeOf(function* () {}), f.constructor.name, Object.hasOwn(f, \"prototype\")]),",
        "  results: [gen().next().value, genExpr().next().value, await asyncFn(), (await asyncGen().next()).value],",
        "}))();",
      ),
    },
  },
  {
    name: "instanceof with function constructors",
    files: {
      "a.mjs": src(
        "export function Point(x) { this.x = x; }",
        "export const Make = function Inner(x) { if (!(this instanceof Inner)) return new Inner(x); this.x = x; };",
        "export function Factory(x) { return Object.create(Factory.prototype, { x: { value: x } }); }",
        "export function makePoint(x) { return new Point(x); }",
      ),
      "b.mjs": src(
        `import { Point } from "./a.mjs";`,
        "Point.prototype.double = function () { return this.x * 2; };",
      ),
      "main.mjs": src(
        `import { Point, Make, Factory, makePoint } from "./a.mjs";`,
        `import "./b.mjs";`,
        "const p = new Point(2);",
        "export default {",
        "  point: [p instanceof Point, makePoint(3) instanceof Point, p.double(), p.constructor === Point, Object.getPrototypeOf(p) === Point.prototype],",
        "  make: [Make(1) instanceof Make, new Make(2) instanceof Make, Make(3).constructor === Make],",
        "  factory: [Factory(1) instanceof Factory, new Factory(2) instanceof Factory, Factory(3).x],",
        "};",
      ),
    },
    untransformed: ["b.mjs"],
  },
];

// Active variants evaluate the real hot runtime against a fake `import.meta.hot`.
const variants = {
  original: undefined,
  forward: { forwardFunctions: true, active: false },
  plain: { forwardFunctions: false, active: false },
  active: { forwardFunctions: true, active: true },
  activePlain: { forwardFunctions: false, active: true },
} as const;
type Variant = keyof typeof variants;

// One context per module URL without its query, so a re-import with a new query is an update.
const fakeHot = src(
  "const contexts = new Map();",
  "globalThis.__equivalenceHot = (url) => {",
  "  const key = url.split(\"?\")[0];",
  "  let hot = contexts.get(key);",
  "  if (!hot) contexts.set(key, (hot = { data: {}, ownerPath: key, on() {}, send() {}, invalidate() {}, accept() {} }));",
  "  return hot;",
  "};",
);
const activate = (code: string) =>
  code.replaceAll("import.meta.hot", "globalThis.__equivalenceHot(import.meta.url)");

const runner = src(
  fakeHot,
  "const out = {};",
  "const replacer = (_key, value) =>",
  "  value === undefined ? \"[undefined]\"",
  "  : typeof value === \"function\" ? `[function ${value.name}/${value.length}]`",
  "  : typeof value === \"bigint\" || typeof value === \"symbol\" ? String(value)",
  "  : value;",
  "for (const dir of process.argv.slice(2)) {",
  "  try {",
  "    const mod = await import(`./${dir}/main.mjs`);",
  "    out[dir] = { value: JSON.parse(JSON.stringify(await mod.default, replacer)) };",
  "  } catch (error) {",
  "    out[dir] = { error: `${error?.name}: ${error?.message}` };",
  "  }",
  "}",
  "const hot = {};",
  "for (const key of contexts.keys()) {",
  "  const dir = key.split(\"/\").at(-2);",
  "  hot[dir] = (hot[dir] ?? 0) + 1;",
  "}",
  "process.stdout.write(JSON.stringify({ out, hot }));",
);

let tempDir: string;
const results = {} as Record<Variant, Record<string, unknown>>;
// Modules per case that created a hot module through the fake context.
const hotModules = {} as Record<Variant, Record<string, number>>;
const transformed = {} as Record<Variant, Array<Record<string, boolean>>>;
const stderr = {} as Record<Variant, string>;

beforeAll(async () => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "harness-di-hmr-equivalence-")));
  // Legacy decorators compile to an import of oxc's helper, resolvable through vite-plus.
  const require = createRequire(import.meta.url);
  const runtime = createRequire(require.resolve("vite-plus/package.json")).resolve(
    "@oxc-project/runtime/package.json",
  );
  mkdirSync(join(tempDir, "node_modules/@oxc-project"), { recursive: true });
  symlinkSync(dirname(runtime), join(tempDir, "node_modules/@oxc-project/runtime"), "dir");

  const compiled = await Promise.all(
    cases.map(async ({ files, decorators }) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(files).map(async ([name, code]) => [
            name,
            decorators
              ? (await transformWithOxc(code, name.replace(/\.mjs$/, ".ts"), { decorator: { legacy: true } })).code
              : code,
          ]),
        ),
      ),
    ),
  );
  await Promise.all(
    (Object.keys(variants) as Variant[]).map(async (variant) => {
      const options = variants[variant];
      transformed[variant] = [];
      for (const [index, files] of compiled.entries()) {
        const flags: Record<string, boolean> = {};
        for (const [name, code] of Object.entries(files)) {
          const path = join(tempDir, variant, String(index), name);
          const out =
            options && (await transformHotModule(code, path, { forwardFunctions: options.forwardFunctions }));
          flags[name] = out !== undefined;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, out ? (options.active ? activate(out.code) : out.code) : code, "utf8");
        }
        transformed[variant].push(flags);
      }
      writeFileSync(join(tempDir, variant, "run.mjs"), runner, "utf8");
    }),
  );
  for (const variant of Object.keys(variants) as Variant[]) {
    const run = spawnSync(
      process.execPath,
      [join(tempDir, variant, "run.mjs"), ...cases.map((_, index) => String(index))],
      { encoding: "utf8" },
    );
    stderr[variant] = run.stderr;
    const output = JSON.parse(run.stdout || "{}");
    results[variant] = output.out ?? {};
    hotModules[variant] = output.hot ?? {};
  }
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("DiHmrPlugin transform preserves native ESM semantics", () => {
  it.each(cases.map((c, index) => [c.name, c, index] as const))("%s", (_name, testCase, index) => {
    for (const variant of ["forward", "plain"] as const) {
      expect(stderr[variant], variant).toBe("");
      const expected = Object.fromEntries(
        Object.keys(testCase.files).map((name) => [name, !testCase.untransformed?.includes(name)]),
      );
      expect(transformed[variant][index], variant).toEqual(expected);
    }
    const original = results.original[index] as { value?: unknown; error?: string } | undefined;
    expect(original).toBeDefined();
    expect("error" in original!, JSON.stringify(original)).toBe(testCase.throws === true);
    expect({ forward: results.forward[index], plain: results.plain[index] }).toEqual({
      forward: original,
      plain: original,
    });
  });
});

describe("DiHmrPlugin transform preserves native ESM semantics with the hot runtime active", () => {
  it.each(cases.map((c, index) => [c.name, c, index] as const))("%s", (_name, testCase, index) => {
    const transformedCount = Object.keys(testCase.files).length - (testCase.untransformed?.length ?? 0);
    for (const variant of ["active", "activePlain"] as const) {
      expect(stderr[variant], variant).toBe("");
      // A throwing case stops before evaluating every module.
      if (testCase.throws) expect(hotModules[variant][index] ?? 0, variant).toBeGreaterThan(0);
      else expect(hotModules[variant][index] ?? 0, variant).toBe(transformedCount);
    }
    expect({ active: results.active[index], activePlain: results.activePlain[index] }).toEqual({
      active: results.original[index],
      activePlain: results.original[index],
    });
  });

  it("an updated exported function takes the length of its new version", async () => {
    const dir = join(tempDir, "update");
    mkdirSync(dir, { recursive: true });
    const id = join(dir, "a.mjs");
    const versions = ["export function add(a) { return a; }", "export function add(a, b) { return a + b; }"];
    const [first, next] = await Promise.all(
      versions.map((code) => transformHotModule(code, id, { forwardFunctions: true })),
    );
    writeFileSync(id, activate(first!.code), "utf8");
    writeFileSync(join(dir, "a.next.mjs"), activate(next!.code), "utf8");
    writeFileSync(
      join(dir, "run.mjs"),
      src(
        fakeHot,
        `import { copyFileSync } from "node:fs";`,
        `const { add } = await import("./a.mjs");`,
        "const before = [add.length, add(1, 2)];",
        `copyFileSync(new URL("./a.next.mjs", import.meta.url), new URL("./a.mjs", import.meta.url));`,
        `const updated = await import("./a.mjs?v=2");`,
        "process.stdout.write(JSON.stringify({ before, after: [add.length, add(1, 2), updated.add.length] }));",
      ),
      "utf8",
    );
    const run = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ before: [1, 1], after: [2, 3, 2] });
  });
});

describe("DiHmrPlugin transform source maps", () => {
  it("maps a thrown error in a transformed module back to its original line", async () => {
    const dir = join(tempDir, "sourcemap");
    mkdirSync(dir, { recursive: true });
    const id = join(dir, "boom.mjs");
    const code = src(
      `import { join } from "node:path";`,
      "export class Holder {}",
      "export function boom() {",
      `  throw new Error(join("declaration", "boom"));`,
      "}",
      "export const crash = () => {",
      `  throw new Error("arrow");`,
      "};",
    );
    const out = await transformHotModule(code, id, { forwardFunctions: true });
    expect(out).toBeDefined();
    writeFileSync(id, out!.code, "utf8");
    writeFileSync(
      join(dir, "main.mjs"),
      src(
        `import { boom, crash } from "./boom.mjs";`,
        "const lines = [];",
        "for (const fn of [boom, crash]) {",
        "  try { fn(); } catch (error) { lines.push(/boom\\.mjs:(\\d+):(\\d+)/.exec(error.stack).slice(1).map(Number)); }",
        "}",
        "process.stdout.write(JSON.stringify(lines));",
      ),
      "utf8",
    );
    const run = spawnSync(process.execPath, [join(dir, "main.mjs")], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    const positions = JSON.parse(run.stdout) as Array<[line: number, column: number]>;
    const map = new SourceMap(JSON.parse(JSON.stringify(out!.map)));
    const original = positions.map(([line, column]) => {
      const entry = map.findEntry(line - 1, column - 1) as { originalLine?: number };
      return entry.originalLine === undefined ? undefined : entry.originalLine + 1;
    });
    // The transform inserts lines above, so the generated lines differ from the original ones.
    expect(positions.map(([line]) => line)).not.toEqual([4, 7]);
    expect(original).toEqual([4, 7]);
  });
});
