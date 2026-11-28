import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  counted,
  createDiHmrFixture,
  diPath,
  variantsPath,
  type DiHmrFixture,
} from "../helpers/di-hmr-fixture.ts";

let fixture: DiHmrFixture;

beforeEach(async () => {
  fixture = await createDiHmrFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});

const di = JSON.stringify(diPath);
const variants = JSON.stringify(variantsPath);
const waitOptions = { timeout: 8000, interval: 20 };

function registryModule(): string[] {
  return [
    `import { onScopeDispose, shallowReactive } from "reactivity";`,
    "export class Registry {",
    "  items = shallowReactive([]);",
    "  add(item) {",
    "    this.items.push(item);",
    "    onScopeDispose(() => this.items.splice(this.items.indexOf(item), 1));",
    "  }",
    "}",
  ];
}

function spyErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const isRejection = (args: unknown[]) =>
    typeof args[0] === "string" && args[0].startsWith("[hmr] update of");
  return {
    rejections: () => spy.mock.calls.filter(isRejection).length,
    others: () => spy.mock.calls.filter((args) => !isRejection(args)),
  };
}

function evalDelta(before: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [name, count] of Object.entries(fixture.evals)) {
    const diff = count - (before[name] ?? 0);
    if (diff > 0) delta[name] = diff;
  }
  return delta;
}

function expectBoundedEvaluations(before: Record<string, number>, max: number): void {
  for (const [name, diff] of Object.entries(evalDelta(before))) {
    expect(diff, `evaluations of ${name}`).toBeLessThanOrEqual(max);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DiHmrPlugin scenario: mini app", () => {
  interface AppState {
    readonly greeting: string;
    readonly separator: string;
    readonly tag: string;
    readonly baseBroken: boolean;
    readonly wrap: boolean;
    readonly suffix: string;
    readonly note: string;
    readonly nested: string;
    readonly greetBroken: boolean;
    readonly extra: boolean;
    readonly extraUsed: boolean;
    readonly format: string | undefined;
  }

  const sources: Record<string, (s: AppState) => string[]> = {
    "app/registry.ts": () => registryModule(),
    "app/core/config.ts": (s) => [counted("config"), `export const GREETING = ${JSON.stringify(s.greeting)};`],
    "app/core/base.ts": (s) => [
      `import { GREETING } from "./config.ts";`,
      counted("base"),
      "export class Greeter {",
      "  readonly id = Math.random();",
      `  greet() { return GREETING + ${JSON.stringify(s.separator)} + tag(); }`,
      "}",
      `export function tag() { return ${JSON.stringify(s.tag)}; }`,
      ...(s.baseBroken ? ['throw new Error("broken base module");'] : []),
    ],
    "app/core/index.ts": () => [counted("index"), 'export * from "./base.ts";', 'export * from "./config.ts";'],
    "app/loud.ts": (s) => [
      `import { Greeter } from "./core/index.ts";`,
      counted("loud"),
      "export class LoudGreeter extends Greeter {",
      `  greet() { return ${s.wrap ? '"<" + super.greet().toUpperCase() + ">"' : "super.greet().toUpperCase()"} + suffix(); }`,
      "}",
      `export function suffix() { return ${JSON.stringify(s.suffix)}; }`,
    ],
    "app/messages.ts": (s) => [
      `import { ExtensibleVariants, variant } from ${variants};`,
      counted("messages"),
      "export abstract class Message extends ExtensibleVariants {}",
      '@variant("test:app:note")',
      "export class Note extends Message {",
      `  label() { return ${JSON.stringify(s.note)} + ":" + this.text; }`,
      "}",
    ],
    "app/extra/format.ts": (s) => [
      counted("format"),
      `export function decorate(value) { return ${JSON.stringify(s.format?.[0])} + value + ${JSON.stringify(s.format?.[1])}; }`,
    ],
    "app/tools.ts": (s) => [
      `import { inject, useSetup } from ${di};`,
      `import { Registry } from "./registry.ts";`,
      `import { Greeter } from "./core/index.ts";`,
      `import { Note } from "./messages.ts";`,
      ...(s.extra && s.format ? [`import { decorate } from "./extra/format.ts";`] : []),
      counted("tools"),
      `export function useGreetTool() { ${s.greetBroken ? 'throw new Error("broken greet tool"); ' : ""}inject(Registry).add("greet:" + inject(Greeter).greet()); }`,
      'export function useNoteTool() { inject(Registry).add("note:" + Note.create({ text: "a" }).label()); }',
      'export function useNested() { useSetup(() => inject(Registry).add("nested:" + nestedLabel())); }',
      `export function nestedLabel() { return ${JSON.stringify(s.nested)}; }`,
      ...(s.extra
        ? [`export function useExtra() { inject(Registry).add("extra:" + ${s.format ? 'decorate("e")' : '"e"'}); }`]
        : []),
    ],
    "app/app.ts": (s) => [
      `import { useGreetTool, useNoteTool, useNested${s.extraUsed ? ", useExtra" : ""} } from "./tools.ts";`,
      `import { LoudGreeter } from "./loud.ts";`,
      counted("app"),
      `export function useApp() { useGreetTool(); useNoteTool(); useNested();${s.extraUsed ? " useExtra();" : ""} }`,
      "export function make() { return new LoudGreeter().greet(); }",
    ],
  };

  function greetValue(s: AppState): string {
    const loud = (s.greeting + s.separator + s.tag).toUpperCase();
    return (s.wrap ? `<${loud}>` : loud) + s.suffix;
  }

  function expected(s: AppState) {
    const extra = s.format ? `${s.format[0]}e${s.format[1]}` : "e";
    return {
      items: [
        `greet:${greetValue(s)}`,
        `note:${s.note}:a`,
        `nested:${s.nested}`,
        ...(s.extraUsed ? [`extra:${extra}`] : []),
      ].sort(),
      make: greetValue(s),
      service: greetValue(s),
      saved: `${s.note}:x`,
    };
  }

  interface Step {
    readonly name: string;
    readonly change: Partial<AppState>;
    readonly update: readonly string[];
    readonly create?: readonly string[];
    readonly keepsService: boolean;
    readonly outcome?: "top-level error" | "rejected";
    // Exact evaluations the step causes, where they are fully determined.
    readonly evaluates?: Readonly<Record<string, number>>;
  }

  const steps: Step[] = [
    { name: "function edit in the base class module", change: { tag: "t2" }, update: ["app/core/base.ts"], keepsService: false },
    { name: "function edit in the subclass module", change: { suffix: "?" }, update: ["app/loud.ts"], keepsService: false },
    { name: "class edit of the subclass", change: { wrap: true }, update: ["app/loud.ts"], keepsService: false },
    { name: "value edit behind the barrel", change: { greeting: "hi" }, update: ["app/core/config.ts"], keepsService: false },
    { name: "class edit of the base class", change: { separator: "-" }, update: ["app/core/base.ts"], keepsService: false },
    { name: "top-level throw in the base module", change: { baseBroken: true, tag: "t3" }, update: ["app/core/base.ts"], keepsService: true, outcome: "top-level error" },
    { name: "fix of the base module", change: { baseBroken: false }, update: ["app/core/base.ts"], keepsService: false },
    { name: "setup throws in the tools module", change: { greetBroken: true, nested: "k2" }, update: ["app/tools.ts"], keepsService: true, outcome: "rejected" },
    { name: "fix of the tools module", change: { greetBroken: false }, update: ["app/tools.ts"], keepsService: true },
    { name: "variant class edit", change: { note: "n2" }, update: ["app/messages.ts"], keepsService: true },
    { name: "add an export", change: { extra: true }, update: ["app/tools.ts"], keepsService: true },
    { name: "use the added export", change: { extraUsed: true }, update: ["app/app.ts"], keepsService: true },
    { name: "import a new module", change: { format: "[]" }, create: ["app/extra/format.ts"], update: ["app/tools.ts"], keepsService: true },
    { name: "function edit in the new module", change: { format: "{}" }, update: ["app/extra/format.ts"], keepsService: true, evaluates: { format: 1 } },
    { name: "stop using the export", change: { extraUsed: false }, update: ["app/app.ts"], keepsService: true },
    { name: "remove the export", change: { extra: false, format: undefined }, update: ["app/tools.ts"], keepsService: true },
    { name: "value edit back", change: { greeting: "hello" }, update: ["app/core/config.ts"], keepsService: false },
  ];

  it("keeps a service graph, variants and setups consistent through a scripted edit sequence", { timeout: 60_000 }, async () => {
    let written: AppState = {
      greeting: "hello",
      separator: ":",
      tag: "t1",
      baseBroken: false,
      wrap: false,
      suffix: "!",
      note: "n1",
      nested: "k1",
      greetBroken: false,
      extra: false,
      extraUsed: false,
      format: undefined,
    };
    let applied = written;
    for (const [name, source] of Object.entries(sources)) {
      if (name !== "app/extra/format.ts") fixture.write(name, source(written));
    }
    const lib = await fixture.runner.import(variantsPath);
    const app = await fixture.load("app/app.ts");
    const core = await fixture.load("app/core/index.ts");
    const loud = await fixture.load("app/loud.ts");
    const messages = await fixture.load("app/messages.ts");
    const { Registry } = await fixture.load("app/registry.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.provide(core.Greeter, loud.LoudGreeter);
    root.setup(() => app.useApp());
    const registry = root.get(Registry) as { items: string[] };
    const saved = JSON.parse(JSON.stringify(lib.serializeValue(messages.Note.create({ text: "x" }))));
    const errors = spyErrors();

    const observe = () => ({
      items: [...registry.items].sort(),
      make: app.make(),
      service: root.get(core.Greeter).greet(),
      saved: lib.deserializeValue(saved).label(),
    });
    expect(observe()).toEqual(expected(written));
    let instance = root.get(core.Greeter);

    for (const step of steps) {
      written = { ...written, ...step.change };
      const before = { ...fixture.evals };
      const rejections = errors.rejections();
      const others = errors.others().length;
      for (const name of step.create ?? []) fixture.write(name, sources[name]!(written));
      for (const name of step.update) fixture.update(name, sources[name]!(written));

      if (step.outcome === "top-level error") {
        await vi.waitFor(() => expect(fixture.evals["base"]).toBeGreaterThan(before["base"] ?? 0), waitOptions);
      } else if (step.outcome === "rejected") {
        await vi.waitFor(() => expect(errors.rejections()).toBe(rejections + 1), waitOptions);
      } else {
        await vi.waitFor(() => expect(observe()).toEqual(expected(written)), waitOptions);
        applied = written;
      }
      await fixture.settle();

      expect(observe(), step.name).toEqual(expected(applied));
      expect(errors.rejections(), step.name).toBe(rejections + (step.outcome === "rejected" ? 1 : 0));
      if (step.outcome === undefined) expect(errors.others(), step.name).toHaveLength(others);
      if (step.keepsService) expect(root.get(core.Greeter), step.name).toBe(instance);
      else expect(root.get(core.Greeter), step.name).not.toBe(instance);
      instance = root.get(core.Greeter);
      if (step.evaluates) expect(evalDelta(before), step.name).toEqual(step.evaluates);
      expectBoundedEvaluations(before, 3);
      if (step.outcome === "top-level error") continue;

      // Importing the modules afresh shows the applied versions and changes nothing.
      const [nextLoud, nextCore, nextMessages] = await Promise.all(
        ["app/loud.ts", "app/core/index.ts", "app/messages.ts"].map((name) => fixture.load(name)),
      );
      await fixture.settle();
      expect(instance, step.name).toBeInstanceOf(nextLoud.LoudGreeter);
      expect(instance, step.name).toBeInstanceOf(nextCore.Greeter);
      expect(new nextLoud.LoudGreeter().greet(), step.name).toBe(greetValue(applied));
      const revived = lib.deserializeValue(saved);
      expect(revived, step.name).toBeInstanceOf(nextMessages.Note);
      expect(revived, step.name).toBeInstanceOf(messages.Message);
      expect(observe(), step.name).toEqual(expected(applied));
      expect(root.get(core.Greeter), step.name).toBe(instance);
    }
    root.dispose();
  });
});

describe("DiHmrPlugin scenario: rapid edits", () => {
  const base = (v: number) => [
    counted("base"),
    `export class Base { value() { return ${v}; } }`,
    `export function label() { return "b${v}"; }`,
  ];
  const sub = (v: number) => [
    `import { Base } from "./r-base.ts";`,
    counted("sub"),
    `export class Sub extends Base { value() { return super.value() * 10 + ${v}; } }`,
    `export function subLabel() { return "s${v}"; }`,
  ];
  const tool = (v: number) => [
    `import { inject } from ${di};`,
    `import { Registry } from "./r-registry.ts";`,
    `import { Base, label } from "./r-base.ts";`,
    `import { subLabel } from "./r-sub.ts";`,
    counted("tool"),
    `export function useTool() { inject(Registry).add(\`t${v}:\${label()}:\${subLabel()}:\${inject(Base).value()}\`); }`,
  ];
  const item = (t: number, b: number, s: number) => `t${t}:b${b}:s${s}:${b * 10 + s}`;

  async function setup() {
    fixture.write("r-registry.ts", registryModule());
    fixture.write("r-base.ts", base(0));
    fixture.write("r-sub.ts", sub(0));
    fixture.write("r-tool.ts", tool(0));
    const { Registry } = await fixture.load("r-registry.ts");
    const baseModule = await fixture.load("r-base.ts");
    const subModule = await fixture.load("r-sub.ts");
    const toolModule = await fixture.load("r-tool.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.provide(baseModule.Base, subModule.Sub);
    root.setup(() => toolModule.useTool());
    const registry = root.get(Registry) as { items: string[] };
    expect([...registry.items]).toEqual([item(0, 0, 0)]);
    return { root, registry, Base: baseModule.Base };
  }

  async function expectConsistent(root: any, Base: Function, registry: { items: string[] }, expectedItem: string) {
    await vi.waitFor(() => expect([...registry.items]).toEqual([expectedItem]), waitOptions);
    await fixture.settle();
    expect([...registry.items]).toEqual([expectedItem]);
    const nextSub = await fixture.load("r-sub.ts");
    await fixture.settle();
    expect(root.get(Base)).toBeInstanceOf(nextSub.Sub);
    expect([...registry.items]).toEqual([expectedItem]);
  }

  it("coalesces edits issued in one tick", { timeout: 30_000 }, async () => {
    const { root, registry, Base } = await setup();
    const errors = spyErrors();
    const before = { ...fixture.evals };
    for (let i = 1; i <= 5; i++) {
      fixture.update("r-base.ts", base(i));
      fixture.update("r-sub.ts", sub(i));
      fixture.update("r-base.ts", base(i));
      fixture.update("r-tool.ts", tool(i));
      fixture.update("r-tool.ts", tool(i));
    }
    await expectConsistent(root, Base, registry, item(5, 5, 5));
    // At most one evaluation per change event, however the updates were batched.
    expectBoundedEvaluations(before, 15);
    expect(errors.rejections()).toBe(0);
    expect(errors.others()).toEqual([]);
    root.dispose();
  });

  it("converges when edits interleave with in-flight updates", { timeout: 30_000 }, async () => {
    const { root, registry, Base } = await setup();
    const errors = spyErrors();
    const versions = { base: 0, sub: 0, tool: 0 };
    const before = { ...fixture.evals };
    for (let i = 1; i <= 24; i++) {
      const target = (["base", "sub", "tool", "base", "base", "sub"] as const)[i % 6]!;
      versions[target] = i;
      if (target === "base") fixture.update("r-base.ts", base(i));
      else if (target === "sub") fixture.update("r-sub.ts", sub(i));
      else fixture.update("r-tool.ts", tool(i));
      // Gaps of a few milliseconds land edits at different phases of the previous update.
      if (i % 4 !== 0) await sleep((i * 7) % 13);
    }
    await expectConsistent(root, Base, registry, item(versions.tool, versions.base, versions.sub));
    expectBoundedEvaluations(before, 30);
    expect(errors.rejections()).toBe(0);
    expect(errors.others()).toEqual([]);
    root.dispose();
  });
});

describe("DiHmrPlugin scenario: evaluations outside updates", () => {
  const base = (v: number) => [counted("base"), `export class Base { value() { return ${v}; } }`];
  const sub = (i: number) => [
    `import { Base } from "./f-base.ts";`,
    counted(`sub${i}`),
    "export class Sub extends Base { value() { return super.value() * 2; } }",
    "export function make() { return new Sub().value(); }",
  ];

  it("re-binds importers loaded fresh while class updates are in flight", { timeout: 30_000 }, async () => {
    fixture.write("f-base.ts", base(0));
    const { Base } = await fixture.load("f-base.ts");
    const root = fixture.di.createRootScope();
    root.provide(Base);
    const subs: any[] = [];
    const delays = [0, 0, 1, 2, 5, 10, 20, 40];
    for (const [i, delay] of delays.entries()) {
      const version = i + 1;
      fixture.write(`f-sub-${i}.ts`, sub(i));
      fixture.update("f-base.ts", base(version));
      if (delay > 0) await sleep(delay);
      subs.push(await fixture.load(`f-sub-${i}.ts`));
      await vi.waitFor(() => {
        expect(root.get(Base).value()).toBe(version);
        for (const mod of subs) expect(mod.make()).toBe(version * 2);
      }, waitOptions);
      const before = { ...fixture.evals };
      await fixture.settle();
      expect(evalDelta(before)).toEqual({});
      for (const mod of subs) expect(mod.make()).toBe(version * 2);
    }
    for (let i = 0; i < delays.length; i++) {
      const fresh = await fixture.load(`f-sub-${i}.ts`);
      expect(new fresh.Sub()).toBeInstanceOf((await fixture.load("f-base.ts")).Base);
    }
    root.dispose();
  });

  it("re-binds an importer loaded fresh while its import waits in a rejected batch", { timeout: 30_000 }, async () => {
    const tool = (label: string) => [
      `export function useTool() { if (globalThis.__breakTool) throw new Error("broken ${label}"); }`,
    ];
    fixture.write("f-tool.ts", tool("v1"));
    fixture.write("f-base.ts", base(1));
    const toolModule = await fixture.load("f-tool.ts");
    const { Base } = await fixture.load("f-base.ts");
    const root = fixture.di.createRootScope();
    root.provide(Base);
    root.setup(() => toolModule.useTool());
    const errors = spyErrors();
    const flags = globalThis as Record<string, unknown>;

    flags["__breakTool"] = true;
    fixture.update("f-tool.ts", tool("v2"));
    await vi.waitFor(() => expect(errors.rejections()).toBe(1), waitOptions);
    fixture.update("f-base.ts", base(2));
    await vi.waitFor(() => expect(errors.rejections()).toBe(2), waitOptions);
    expect(root.get(Base).value()).toBe(1);

    fixture.write("f-sub-0.ts", sub(0));
    const late = await fixture.load("f-sub-0.ts");
    await fixture.settle();
    expect(root.get(Base).value()).toBe(1);
    expect(errors.rejections()).toBe(2);

    flags["__breakTool"] = false;
    fixture.update("f-tool.ts", tool("v3"));
    await vi.waitFor(() => {
      expect(root.get(Base).value()).toBe(2);
      expect(late.make()).toBe(4);
    }, waitOptions);
    await fixture.settle();
    const fresh = await fixture.load("f-sub-0.ts");
    expect(new fresh.Sub()).toBeInstanceOf((await fixture.load("f-base.ts")).Base);
    expect(late.make()).toBe(4);
    expect(errors.rejections()).toBe(2);
    expect(errors.others()).toEqual([]);
    root.dispose();
  });
});

describe("DiHmrPlugin scenario: three-module import cycle", () => {
  interface CycleState {
    readonly a: number;
    readonly b: number;
    readonly c: number;
  }
  const sources: Record<string, (s: CycleState) => string[]> = {
    "c-a.ts": (s) => [
      `import { fb } from "./c-b.ts";`,
      counted("a"),
      `export class A { value() { return ${s.a} + fb(); } }`,
    ],
    "c-b.ts": (s) => [
      `import { config } from "./c-c.ts";`,
      counted("b"),
      `export function fb() { return config.v * ${s.b}; }`,
    ],
    "c-c.ts": (s) => [
      `import { A } from "./c-a.ts";`,
      counted("c"),
      `export const config = { v: ${s.c} };`,
      "export function makeA() { return new A().value(); }",
      "export function isA(value) { return value instanceof A; }",
    ],
  };
  const value = (s: CycleState) => s.a + s.c * s.b;

  it("settles and stays consistent while each module of the cycle is edited in turn", { timeout: 45_000 }, async () => {
    let state: CycleState = { a: 1, b: 2, c: 3 };
    for (const [name, source] of Object.entries(sources)) fixture.write(name, source(state));
    const a = await fixture.load("c-a.ts");
    const c = await fixture.load("c-c.ts");
    const root = fixture.di.createRootScope();
    root.provide(a.A);
    expect(c.makeA()).toBe(value(state));
    const errors = spyErrors();

    const edits: Array<Partial<CycleState>> = [
      { a: 10 },
      { b: 3 },
      { c: 4 },
      { a: 20 },
      { b: 5 },
      { c: 6 },
      { a: 30, c: 7 },
      { b: 6, c: 8 },
      { a: 40, b: 7, c: 9 },
    ];
    for (const edit of edits) {
      const label = JSON.stringify(edit);
      const before = { ...fixture.evals };
      state = { ...state, ...edit };
      for (const key of Object.keys(edit)) fixture.update(`c-${key}.ts`, sources[`c-${key}.ts`]!(state));
      await vi.waitFor(() => {
        expect(c.makeA()).toBe(value(state));
        expect(root.get(a.A).value()).toBe(value(state));
      }, waitOptions);
      await fixture.settle(400);
      expectBoundedEvaluations(before, 4);
      expect(c.makeA(), label).toBe(value(state));
      expect(root.get(a.A).value(), label).toBe(value(state));
      expect(c.isA(root.get(a.A)), label).toBe(true);
      const fresh = await fixture.load("c-a.ts");
      await fixture.settle();
      expect(root.get(a.A), label).toBeInstanceOf(fresh.A);
      expect(new fresh.A().value(), label).toBe(value(state));
    }
    expect(errors.rejections()).toBe(0);
    expect(errors.others()).toEqual([]);
    root.dispose();
  });
});

describe("DiHmrPlugin scenario: rollback of a combined batch", () => {
  const svc = (version: string) => [
    counted("svc"),
    `export class Svc { readonly id = Math.random(); version() { return "${version}"; } }`,
    `export function describeSvc() { return "d-${version}"; }`,
  ];
  const msg = (version: string) => [
    `import { ExtensibleVariants, variant } from ${variants};`,
    counted("msg"),
    '@variant("test:rollback:note")',
    `export class Note extends ExtensibleVariants { label() { return "${version}"; } }`,
    "export function makeNote() { return Note.create({}); }",
  ];
  const tool = (version: string, broken = false) => [
    `import { inject } from ${di};`,
    `import { Registry } from "./rb-registry.ts";`,
    `import { Svc, describeSvc } from "./rb-svc.ts";`,
    counted("tool"),
    `export function useTool() { ${broken ? 'throw new Error("broken tool"); ' : ""}inject(Registry).add(\`${version}:\${inject(Svc).version()}:\${describeSvc()}\`); }`,
  ];

  it("restores classes, forwarders and variants together and applies them together after the fix", { timeout: 30_000 }, async () => {
    fixture.write("rb-registry.ts", registryModule());
    fixture.write("rb-svc.ts", svc("v1"));
    fixture.write("rb-msg.ts", msg("m1"));
    fixture.write("rb-tool.ts", tool("t1"));
    const lib = await fixture.runner.import(variantsPath);
    const { Registry } = await fixture.load("rb-registry.ts");
    const svcModule = await fixture.load("rb-svc.ts");
    const msgModule = await fixture.load("rb-msg.ts");
    const toolModule = await fixture.load("rb-tool.ts");
    const root = fixture.di.createRootScope();
    root.provideAll([Registry, svcModule.Svc]);
    root.setup(() => toolModule.useTool());
    const registry = root.get(Registry) as { items: string[] };
    const note = msgModule.makeNote();
    const saved = JSON.parse(JSON.stringify(lib.serializeValue(note)));
    const errors = spyErrors();

    const observe = () => ({
      items: [...registry.items],
      svc: root.get(svcModule.Svc).version(),
      describe: svcModule.describeSvc(),
      created: msgModule.makeNote().label(),
      saved: lib.deserializeValue(saved).label(),
      old: note.label(),
    });
    const initial = { items: ["t1:v1:d-v1"], svc: "v1", describe: "d-v1", created: "m1", saved: "m1", old: "m1" };
    expect(observe()).toEqual(initial);

    fixture.update("rb-tool.ts", tool("t2", true));
    await vi.waitFor(() => expect(errors.rejections()).toBe(1), waitOptions);
    fixture.update("rb-svc.ts", svc("v2"));
    await vi.waitFor(() => expect(errors.rejections()).toBe(2), waitOptions);
    fixture.update("rb-msg.ts", msg("m2"));
    await vi.waitFor(() => expect(errors.rejections()).toBe(3), waitOptions);
    await fixture.settle();
    expect(observe()).toEqual(initial);
    expect(root.get(svcModule.Svc)).toBeInstanceOf(svcModule.Svc);
    expect(errors.rejections()).toBe(3);

    fixture.update("rb-tool.ts", tool("t3"));
    const next = { items: ["t3:v2:d-v2"], svc: "v2", describe: "d-v2", created: "m2", saved: "m2", old: "m1" };
    await vi.waitFor(() => expect(observe()).toEqual(next), waitOptions);
    await fixture.settle();
    expect(observe()).toEqual(next);
    expect(errors.rejections()).toBe(3);
    expect(errors.others()).toEqual([]);
    const [nextSvc, nextMsg] = await Promise.all(["rb-svc.ts", "rb-msg.ts"].map((name) => fixture.load(name)));
    expect(root.get(svcModule.Svc)).toBeInstanceOf(nextSvc.Svc);
    expect(lib.deserializeValue(saved)).toBeInstanceOf(nextMsg.Note);
    expect(note).toBeInstanceOf(nextMsg.Note);
    root.dispose();
  });
});

describe("DiHmrPlugin scenario: seeded stress", () => {
  const modules = ["config", "base", "index", "sub", "tools"] as const;
  type StressModule = (typeof modules)[number];
  interface Params {
    readonly f: number;
    readonly o: number;
    readonly b: number;
    readonly bt: string;
    readonly x: number;
    readonly s: number;
    readonly st: string;
    readonly t: string;
    readonly m: string;
    readonly extra: Readonly<Record<StressModule, boolean>>;
    readonly broken: StressModule | undefined;
    readonly toolThrows: boolean;
  }

  const extra = (p: Params, module: StressModule) =>
    p.extra[module] ? [`export function extra_${module}() { return 0; }`] : [];
  const broken = (p: Params, module: StressModule) =>
    p.broken === module ? [`throw new Error("broken ${module}");`] : [];
  const sources: Record<StressModule, (p: Params) => string[]> = {
    config: (p) => [
      counted("config"),
      `export const FACTOR = ${p.f};`,
      `export function offset() { return ${p.o}; }`,
      ...extra(p, "config"),
      ...broken(p, "config"),
    ],
    base: (p) => [
      `import { offset } from "./s-config.ts";`,
      counted("base"),
      `export class Base { readonly id = Math.random(); base() { return ${p.b} + offset(); } value() { return this.base(); } }`,
      `export function baseTag() { return "${p.bt}"; }`,
      ...extra(p, "base"),
      ...broken(p, "base"),
    ],
    index: (p) => [
      'export * from "./s-base.ts";',
      'export * from "./s-config.ts";',
      counted("index"),
      `export const BARREL = ${p.x};`,
      ...extra(p, "index"),
      ...broken(p, "index"),
    ],
    sub: (p) => [
      `import { Base, FACTOR } from "./s-index.ts";`,
      counted("sub"),
      `export class Sub extends Base { value() { return this.base() * FACTOR + ${p.s}; } }`,
      `export function subTag() { return "${p.st}"; }`,
      ...extra(p, "sub"),
      ...broken(p, "sub"),
    ],
    tools: (p) => [
      `import { inject } from ${di};`,
      `import { ExtensibleVariants, variant } from ${variants};`,
      `import { Registry } from "./s-registry.ts";`,
      `import { Base, baseTag, BARREL } from "./s-index.ts";`,
      `import { subTag } from "./s-sub.ts";`,
      counted("tools"),
      '@variant("test:stress:msg")',
      `export class Msg extends ExtensibleVariants { label() { return "${p.m}"; } }`,
      `export function useTools() { ${p.toolThrows ? 'throw new Error("broken setup"); ' : ""}inject(Registry).add(\`tool:${p.t}:\${inject(Base).value()}:\${baseTag()}:\${subTag()}:\${BARREL}\`); }`,
      "export function makeMsg() { return Msg.create({}); }",
      ...extra(p, "tools"),
      ...broken(p, "tools"),
    ],
  };
  const file = (module: StressModule) => `s-${module}.ts`;
  // Re-evaluating a module replaces its classes, so the service is rebuilt.
  const definesService = (module: StressModule) => module === "base" || module === "sub";
  const value = (p: Params) => (p.b + p.o) * p.f + p.s;
  const expected = (p: Params) => ({
    items: [`tool:${p.t}:${value(p)}:${p.bt}:${p.st}:${p.x}`],
    value: value(p),
    msg: p.m,
    saved: p.m,
  });

  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const kinds = ["function", "function", "class", "value", "variant", "export", "top-level throw", "rejected setup"] as const;
  const moduleOf: Record<string, StressModule> = { f: "config", o: "config", b: "base", bt: "base", x: "index", s: "sub", st: "sub", t: "tools", m: "tools" };

  type Pick = <T>(items: readonly T[]) => T;

  async function runStress(pick: Pick, count: number): Promise<void> {
    let written: Params = {
      f: 2, o: 1, b: 3, bt: "bt0", x: 0, s: 4, st: "st0", t: "t0", m: "m0",
      extra: { config: false, base: false, index: false, sub: false, tools: false },
      broken: undefined,
      toolThrows: false,
    };
    let applied = written;
    fixture.write("s-registry.ts", registryModule());
    for (const module of modules) fixture.write(file(module), sources[module](written));
    // A changed export list invalidates the importers; without an accepting one, Vite reloads the
    // whole graph and the forwarders held here stop following updates.
    fixture.write("s-entry.ts", [...modules.map((module) => `import "./${file(module)}";`), "export function entry() {}"]);
    await fixture.load("s-entry.ts");
    const lib = await fixture.runner.import(variantsPath);
    const { Registry } = await fixture.load("s-registry.ts");
    const index = await fixture.load("s-index.ts");
    const sub = await fixture.load("s-sub.ts");
    const tools = await fixture.load("s-tools.ts");
    const root = fixture.di.createRootScope();
    root.provide(Registry);
    root.provide(index.Base, sub.Sub);
    root.setup(() => tools.useTools());
    const registry = root.get(Registry) as { items: string[] };
    const saved = JSON.parse(JSON.stringify(lib.serializeValue(tools.makeMsg())));
    const errors = spyErrors();
    const observe = () => ({
      items: [...registry.items],
      value: root.get(index.Base).value(),
      msg: tools.makeMsg().label(),
      saved: lib.deserializeValue(saved).label(),
    });
    expect(observe()).toEqual(expected(written));
    let instance = root.get(index.Base);
    const log: string[] = [];

    const write = (change: Partial<Params>, module: StressModule) => {
      written = { ...written, ...change };
      fixture.update(file(module), sources[module](written));
    };
    // A rolled back class replacement keeps the running instance.
    const settled = async (label: string, keeps: boolean | undefined) => {
      await fixture.settle(200);
      expect(observe(), label).toEqual(expected(applied));
      if (keeps === true) expect(root.get(index.Base), label).toBe(instance);
      else if (keeps === false) expect(root.get(index.Base), label).not.toBe(instance);
      instance = root.get(index.Base);
    };
    const applies = async (label: string, keeps: boolean) => {
      await vi.waitFor(() => expect(observe(), label).toEqual(expected(written)), waitOptions);
      applied = written;
      await settled(label, keeps);
    };
    const fresh = (step: number) => step % 10 === 9;

    for (let step = 0; step < count; step++) {
      const kind = pick(kinds);
      const before = { ...fixture.evals };
      const rejections = errors.rejections();
      const others = errors.others().length;
      let label = `step ${step}: ${kind}`;
      switch (kind) {
        case "function": {
          const key = pick(["o", "bt", "st", "t"] as const);
          label += ` ${key}`;
          write({ [key]: key === "o" ? written.o + 1 : `${key}${step}` }, moduleOf[key]!);
          await applies(label, !definesService(moduleOf[key]!));
          break;
        }
        case "class": {
          const key = pick(["b", "s"] as const);
          label += ` ${key}`;
          write({ [key]: written[key] + 1 }, moduleOf[key]!);
          await applies(label, false);
          break;
        }
        case "value": {
          const key = pick(["f", "x"] as const);
          label += ` ${key}`;
          write({ [key]: key === "f" ? (written.f % 3) + 1 : written.x + 1 }, moduleOf[key]!);
          // The subclass module reads the factor.
          await applies(label, key !== "f");
          break;
        }
        case "variant":
          write({ m: `m${step}` }, "tools");
          await applies(label, true);
          break;
        case "export": {
          const module = pick(modules);
          label += ` ${module}`;
          write({ extra: { ...written.extra, [module]: !written.extra[module] } }, module);
          // Only the export list changes: nothing observable does.
          await vi.waitFor(() => expect(fixture.evals[module]).toBeGreaterThan(before[module] ?? 0), waitOptions);
          applied = written;
          await settled(label, !definesService(module));
          break;
        }
        case "top-level throw": {
          const module = pick(modules);
          label += ` ${module}`;
          write({ broken: module }, module);
          await vi.waitFor(() => expect(fixture.evals[module]).toBeGreaterThan(before[module] ?? 0), waitOptions);
          await settled(`${label} (broken)`, true);
          const count = fixture.evals[module]!;
          write({ broken: undefined }, module);
          await vi.waitFor(() => expect(fixture.evals[module]).toBeGreaterThan(count), waitOptions);
          applied = written;
          await settled(`${label} (fixed)`, !definesService(module));
          break;
        }
        case "rejected setup": {
          const key = pick(["o", "bt", "st", "b", "s"] as const);
          label += ` with ${key}`;
          write({ toolThrows: true, t: `r${step}` }, "tools");
          await vi.waitFor(() => expect(errors.rejections()).toBe(rejections + 1), waitOptions);
          await settled(`${label} (rejected)`, true);
          write({ [key]: typeof written[key] === "number" ? (written[key] as number) + 1 : `${key}${step}` }, moduleOf[key]!);
          await vi.waitFor(() => expect(errors.rejections()).toBe(rejections + 2), waitOptions);
          await settled(`${label} (retried)`, true);
          write({ toolThrows: false }, "tools");
          await applies(`${label} (fixed)`, !definesService(moduleOf[key]!));
          expect(errors.rejections(), label).toBe(rejections + 2);
          break;
        }
      }
      log.push(label);
      if (kind !== "top-level throw") expect(errors.others(), label).toHaveLength(others);
      if (kind !== "rejected setup") expect(errors.rejections(), label).toBe(rejections);
      expectBoundedEvaluations(before, kind === "rejected setup" || kind === "top-level throw" ? 8 : 4);

      if (fresh(step)) {
        const [nextIndex, nextSub, nextTools] = await Promise.all(
          ["s-index.ts", "s-sub.ts", "s-tools.ts"].map((name) => fixture.load(name)),
        );
        await fixture.settle(200);
        expect(instance, label).toBeInstanceOf(nextSub.Sub);
        expect(instance, label).toBeInstanceOf(nextIndex.Base);
        expect(new nextSub.Sub().value(), label).toBe(value(applied));
        expect(lib.deserializeValue(saved), label).toBeInstanceOf(nextTools.Msg);
        expect(observe(), label).toEqual(expected(applied));
        expect(root.get(index.Base), label).toBe(instance);
      }
    }
    expect(log).toHaveLength(count);
    root.dispose();
  }

  it("matches the model through 40 seeded random edits of 5 modules", { timeout: 90_000 }, async () => {
    const rng = mulberry32(0x5eed2026);
    await runStress((items) => items[Math.floor(rng() * items.length)]!, 40);
  });
});
