import { describe, expect, it } from "vite-plus/test";
import {
  onScopeDispose,
  shallowReactive,
  shallowRef,
} from "../../packages/di/node_modules/reactivity/dist/index.js";
import {
  createDescriptor,
  createRootScope,
  inject,
  optionalInject,
  replaceService,
  CurrentScope,
  type Scope,
  useServices,
  useSetup,
} from "../../packages/di/src/index.ts";
import { isSamePlainData } from "../../packages/di/src/descriptors.ts";
import { createHotModule } from "../../packages/di/src/hot.ts";
import { batchScopeUpdates } from "../../packages/di/src/scope.ts";

describe("service versions", () => {
  it("resolves a replaced service through any of its versions", () => {
    class GreeterV1 {
      greet(): string {
        return "v1";
      }
    }
    class GreeterV2 {
      greet(): string {
        return "v2";
      }
    }
    class ImplV2 extends GreeterV2 {}

    const root = createRootScope();
    try {
      root.provide(GreeterV1);
      replaceService(GreeterV1, GreeterV2 as unknown as typeof GreeterV1);

      expect(root.get(GreeterV2).greet()).toBe("v2");
      expect(root.get(GreeterV1)).toBe(root.get(GreeterV2));
      expect(root.run(() => inject(GreeterV2))).toBe(root.get(GreeterV1));

      root.provide(ImplV2);
      expect(root.get(GreeterV1)).toBeInstanceOf(ImplV2);
      root.unprovide(GreeterV2);
      expect(() => root.get(GreeterV1)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });
});

describe("idempotent provide", () => {
  it("keeps instances when an equal registration is provided again", () => {
    const constructed: string[] = [];
    class Config {
      constructor(readonly options: { readonly path: string; readonly tags: string[] }) {
        constructed.push(options.path);
      }
    }
    class User {
      readonly config = inject(Config);
    }

    const root = createRootScope();
    try {
      root.provideAll([createDescriptor(Config, { path: "a", tags: ["x"] }), User]);
      const user = root.get(User);

      root.provideAll([createDescriptor(Config, { path: "a", tags: ["x"] }), User]);
      expect(root.get(User)).toBe(user);
      expect(constructed).toEqual(["a"]);

      root.provide(createDescriptor(Config, { path: "b", tags: ["x"] }));
      expect(root.get(User)).not.toBe(user);
      expect(root.get(User).config.options.path).toBe("b");
      expect(constructed).toEqual(["a", "b"]);
    } finally {
      root.dispose();
    }
  });
});

describe("setup-owned registrations", () => {
  it("removes services a setup stops providing when it re-runs", () => {
    const events: string[] = [];
    class Kept {
      constructor() {
        events.push("construct:kept");
        onScopeDispose(() => events.push("dispose:kept"));
      }
    }
    class Dropped {
      constructor() {
        events.push("construct:dropped");
        onScopeDispose(() => events.push("dispose:dropped"));
      }
    }

    const withDropped = shallowRef(true);
    const root = createRootScope();
    try {
      root.setup(() => {
        root.provideAll(withDropped.value ? [Kept, Dropped] : [Kept]);
      });
      expect(events).toEqual(["construct:kept", "construct:dropped"]);

      withDropped.value = false;
      expect(events).toEqual(["construct:kept", "construct:dropped", "dispose:dropped"]);
      expect(() => root.get(Dropped)).toThrow("unknown service");
      expect(root.get(Kept)).toBeInstanceOf(Kept);
    } finally {
      root.dispose();
    }
  });

  it("does not track what the previous run's cleanups read", () => {
    const trigger = shallowRef(0);
    const registry = shallowReactive(new Map<string, number>());
    let runs = 0;
    const root = createRootScope();
    try {
      root.setup(() => {
        runs++;
        void trigger.value;
        onScopeDispose(() => registry.get("x"));
      });
      trigger.value = 1;
      registry.set("x", 1);
      expect(runs).toBe(2);
    } finally {
      root.dispose();
    }
  });

  it("does not re-run a setup because of the services it provides", () => {
    let runs = 0;
    class Service {}
    const root = createRootScope();
    try {
      root.setup(() => {
        runs++;
        root.provide(Service);
        root.get(Service);
      });
      root.provide(Service);
      expect(runs).toBe(1);
    } finally {
      root.dispose();
    }
  });

  it("keeps a registration that was provided again outside the setup", () => {
    class Service {}
    class Override extends Service {}
    const withService = shallowRef(true);
    const root = createRootScope();
    try {
      root.setup(() => {
        if (withService.value) root.provide(Service);
      });
      root.provide(Service, Override);

      withService.value = false;
      expect(root.get(Service)).toBeInstanceOf(Override);
    } finally {
      root.dispose();
    }
  });
});

describe("batched scope updates", () => {
  it("re-computes dependents once after every change of the batch", () => {
    const seen: string[] = [];
    class First {
      readonly value: string = "first:v1";
    }
    class Second {
      readonly value: string = "second:v1";
    }
    class FirstV2 extends First {
      override readonly value = "first:v2";
    }
    class SecondV2 extends Second {
      override readonly value = "second:v2";
    }
    class Consumer {
      constructor() {
        seen.push(`${inject(First).value}+${inject(Second).value}`);
      }
    }

    const root = createRootScope();
    try {
      root.provideAll([First, Second, Consumer]);
      root.setup(() => {
        seen.push(`setup:${inject(First).value}+${inject(Second).value}`);
      });
      root.get(Consumer);
      seen.length = 0;

      const errors = batchScopeUpdates(() => {
        replaceService(First, FirstV2);
        replaceService(Second, SecondV2);
      });
      expect(errors).toEqual([]);
      root.get(Consumer);
      expect(seen.sort()).toEqual(["first:v2+second:v2", "setup:first:v2+second:v2"]);
    } finally {
      root.dispose();
    }
  });
});

describe("setup re-run errors", () => {
  it("reports re-run errors to the capturing caller and recovers on the next trigger", () => {
    const mode = shallowRef<"ok" | "fail">("ok");
    const registered: string[] = [];
    const root = createRootScope();
    try {
      root.setup(() => {
        const value = mode.value;
        if (value === "fail") throw new Error("broken setup");
        registered.push(value);
        onScopeDispose(() => registered.splice(registered.indexOf(value), 1));
      });
      expect(registered).toEqual(["ok"]);

      const errors = batchScopeUpdates(() => {
        mode.value = "fail";
      });
      expect(errors).toHaveLength(1);
      expect(registered).toEqual([]);

      mode.value = "ok";
      expect(registered).toEqual(["ok"]);
    } finally {
      root.dispose();
    }
  });
});

describe("failed construction", () => {
  it("surfaces the constructor error of a new service and leaves the scope usable", () => {
    let fail = true;
    class Config {
      readonly value = "config";
    }
    class Broken {
      readonly config = inject(Config);
      constructor() {
        if (fail) throw new Error("constructor failed");
      }
    }
    const root = createRootScope();
    try {
      expect(() => root.provideAll([Config, Broken])).toThrow("constructor failed");
      expect(() => root.get(Broken)).toThrow("unknown service");

      fail = false;
      root.provideAll([Config, Broken]);
      expect(root.get(Broken).config.value).toBe("config");
    } finally {
      root.dispose();
    }
  });
});

describe("nested setups", () => {
  function counted(events: string[], name: string) {
    return class {
      constructor() {
        events.push(`construct:${name}`);
        onScopeDispose(() => events.push(`dispose:${name}`));
      }
    };
  }

  it("re-runs only the nested setup whose dependencies changed", () => {
    const outer = shallowRef(0);
    const inner = shallowRef(0);
    const runs: string[] = [];
    const root = createRootScope();
    try {
      root.setup(() => {
        runs.push(`outer:${outer.value}`);
        useSetup(() => runs.push(`inner:${inner.value}`));
      });
      inner.value = 1;
      expect(runs).toEqual(["outer:0", "inner:0", "inner:1"]);
      outer.value = 1;
      expect(runs).toEqual(["outer:0", "inner:0", "inner:1", "outer:1", "inner:1"]);
    } finally {
      root.dispose();
    }
  });

  it("keeps services the enclosing re-run provides again and releases the rest", () => {
    const events: string[] = [];
    const Kept = counted(events, "kept");
    const Dropped = counted(events, "dropped");
    const outer = shallowRef(true);
    const root = createRootScope();
    try {
      root.setup(() => {
        const withDropped = outer.value;
        useSetup(() => useServices(withDropped ? [Kept, Dropped] : [Kept]));
      });
      root.get(Kept);
      root.get(Dropped);
      outer.value = false;
      expect(events).toEqual(["construct:kept", "construct:dropped", "dispose:dropped"]);
      expect(() => root.get(Dropped)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });

  it("releases only its own services when a nested setup re-runs", () => {
    const events: string[] = [];
    const Outer = counted(events, "outer");
    const Inner = counted(events, "inner");
    const inner = shallowRef(true);
    const root = createRootScope();
    try {
      root.setup(() => {
        useServices([Outer]);
        useSetup(() => useServices(inner.value ? [Inner] : []));
      });
      root.get(Outer);
      root.get(Inner);
      inner.value = false;
      expect(events).toEqual(["construct:outer", "construct:inner", "dispose:inner"]);
      expect(root.get(Outer)).toBeInstanceOf(Outer);
    } finally {
      root.dispose();
    }
  });

  it("keeps the services of a nested setup whose re-run fails", () => {
    const events: string[] = [];
    const Inner = counted(events, "inner");
    const fail = shallowRef(false);
    const root = createRootScope();
    try {
      root.setup(() => {
        useSetup(() => {
          useServices([Inner]);
          if (fail.value) throw new Error("nested failed");
        });
      });
      root.get(Inner);
      const errors = batchScopeUpdates(() => {
        fail.value = true;
      });
      expect(errors).toHaveLength(1);
      expect(events).toEqual(["construct:inner"]);
      expect(root.get(Inner)).toBeInstanceOf(Inner);
    } finally {
      root.dispose();
    }
  });

  it("keeps nested services through a failed enclosing re-run and reconciles on the next one", () => {
    const events: string[] = [];
    const Inner = counted(events, "inner");
    const step = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        const current = step.value;
        if (current === 1) throw new Error("outer failed");
        useSetup(() => useServices(current === 0 ? [Inner] : []));
      });
      root.get(Inner);
      expect(batchScopeUpdates(() => (step.value = 1))).toHaveLength(1);
      expect(root.get(Inner)).toBeInstanceOf(Inner);
      step.value = 2;
      expect(events).toEqual(["construct:inner", "dispose:inner"]);
      expect(() => root.get(Inner)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });

  it("leaves nothing running when a nested setup's first run fails", () => {
    class Partial {}
    const runs: string[] = [];
    const dep = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        try {
          useSetup(() => {
            runs.push(`nested:${dep.value}`);
            useServices([Partial]);
            throw new Error("nested failed");
          });
        } catch {}
      });
      expect(() => root.get(Partial)).toThrow("unknown service");
      expect(batchScopeUpdates(() => {})).toEqual([]);
      dep.value = 1;
      expect(runs).toEqual(["nested:0"]);
    } finally {
      root.dispose();
    }
  });

  it("reports the first run's own error when what it provided cannot be released", () => {
    class A {}
    class C {
      readonly a = inject(A);
    }
    const root = createRootScope();
    const child = root.createChild();
    try {
      expect(() =>
        root.setup(() => {
          useServices([A]);
          child.provide(C);
          child.get(C);
          throw new Error("original");
        }),
      ).toThrow("original");
    } finally {
      root.dispose();
    }
  });

  it("leaves nothing running when a top-level setup's first run fails", () => {
    const runs: number[] = [];
    const dep = shallowRef(0);
    const root = createRootScope();
    try {
      expect(() =>
        root.setup(() => {
          runs.push(dep.value);
          throw new Error("first run failed");
        }),
      ).toThrow("first run failed");
      dep.value = 1;
      expect(runs).toEqual([0]);
    } finally {
      root.dispose();
    }
  });

  it("can only be used inside a running setup", () => {
    expect(() => useSetup(() => {})).toThrow("useSetup() can only be called inside a setup");
    expect(() => useServices([])).toThrow("useServices() can only be called inside a setup");
  });
});

describe("setup ownership", () => {
  it("does not own what services it triggers provide into their own scopes", () => {
    class Child {}
    class Session {
      readonly scope: Scope;
      constructor() {
        this.scope = inject(CurrentScope).createChild({ id: "session" });
        this.scope.provide(Child);
      }
    }
    const trigger = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        void trigger.value;
        root.provide(Session);
      });
      const session = root.get(Session);
      trigger.value++;
      expect(root.get(Session)).toBe(session);
      expect(session.scope.get(Child)).toBeInstanceOf(Child);
    } finally {
      root.dispose();
    }
  });
});

describe("failed releases", () => {
  it("keeps owning a service it could not release and releases it on a later run", () => {
    class A {}
    class B {
      readonly a = inject(A);
    }
    const step = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        const current = step.value;
        if (current === 0) useServices([A, B]);
        if (current === 1) useServices([B]);
      });
      root.get(B);
      expect(batchScopeUpdates(() => (step.value = 1))).toHaveLength(1);
      expect(root.get(A)).toBeInstanceOf(A);
      step.value = 2;
      expect(() => root.get(A)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });
});

describe("failed provides", () => {
  it("keeps existing services when a new one in the same provideAll fails to construct", () => {
    class Config {
      readonly n: number;
      constructor(n: number) {
        this.n = n;
      }
    }
    class Broken {
      constructor() {
        throw new Error("broken");
      }
    }
    const root = createRootScope();
    try {
      root.provide(createDescriptor(Config, 1));
      const before = root.get(Config);
      expect(() => root.provideAll([createDescriptor(Config, 2), Broken])).toThrow("broken");
      expect(root.get(Config)).toBe(before);
    } finally {
      root.dispose();
    }
  });
});

describe("failed releases keep instances", () => {
  it("keeps the instances of a service whose unprovide fails and of its dependents", () => {
    class A {}
    class B {
      readonly a = inject(A);
    }
    const root = createRootScope();
    try {
      root.provideAll([A, B]);
      const a = root.get(A);
      const b = root.get(B);
      expect(() => root.unprovide(A)).toThrow("unknown service");
      expect(root.get(A)).toBe(a);
      expect(root.get(B)).toBe(b);
    } finally {
      root.dispose();
    }
  });

  it("keeps the instance of a service a setup could not release", () => {
    class A {}
    class B {
      readonly a = inject(A);
    }
    const step = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => useServices(step.value === 0 ? [A, B] : [B]));
      const a = root.get(A);
      expect(batchScopeUpdates(() => (step.value = 1))).toHaveLength(1);
      expect(root.get(A)).toBe(a);
    } finally {
      root.dispose();
    }
  });
});

describe("nested setups rebuilt by their enclosing re-run", () => {
  it("can provide a new service on the rebuilt run", () => {
    class Added {}
    const step = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        const current = step.value;
        useSetup(() => useServices(current === 0 ? [] : [Added]));
      });
      expect(batchScopeUpdates(() => (step.value = 1))).toEqual([]);
      expect(root.get(Added)).toBeInstanceOf(Added);
    } finally {
      root.dispose();
    }
  });
});

describe("releasing what depends on each other", () => {
  it("releases everything a failed first run provided, dependents listed first", () => {
    class A {}
    class B {
      readonly a = inject(A);
    }
    const root = createRootScope();
    try {
      expect(() =>
        root.setup(() => {
          useServices([B, A]);
          throw new Error("first run failed");
        }),
      ).toThrow("first run failed");
      expect(() => root.get(A)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });

  it("releases a service whose dependent a stale nested setup releases in the same re-run", () => {
    class A {}
    class B {
      readonly a = inject(A);
    }
    const step = shallowRef(0);
    const root = createRootScope();
    try {
      root.setup(() => {
        if (step.value === 0) {
          useServices([A]);
          useSetup(() => useServices([B]));
        }
      });
      expect(batchScopeUpdates(() => (step.value = 1))).toEqual([]);
      expect(() => root.get(A)).toThrow("unknown service");
    } finally {
      root.dispose();
    }
  });
});

describe("failed provides in a child scope", () => {
  it("keeps dependents of a parent service the failed provide would have shadowed", () => {
    class A {}
    class Cfg {}
    class B {
      readonly a = inject(A);
    }
    class D {
      readonly b = inject(B);
      readonly cfg = inject(Cfg);
    }
    const root = createRootScope();
    try {
      root.provide(A);
      const child = root.createChild();
      child.provide(B);
      const b = child.get(B);
      expect(() => child.provideAll([A, D])).toThrow("unknown service 'Cfg'");
      expect(child.get(B)).toBe(b);
    } finally {
      root.dispose();
    }
  });
});

describe("provide ordering and replacement failures", () => {
  it("constructs a new service against a configuration changed in the same provideAll", () => {
    class Config {
      readonly version: number;
      constructor(version: number) {
        this.version = version;
      }
    }
    class NeedsV2 {
      constructor() {
        if (inject(Config).version !== 2) throw new Error("needs version 2");
      }
    }
    const root = createRootScope();
    try {
      root.provide(createDescriptor(Config, 1));
      root.get(Config);
      root.provideAll([createDescriptor(Config, 2), NeedsV2]);
      expect(root.get(NeedsV2)).toBeInstanceOf(NeedsV2);
    } finally {
      root.dispose();
    }
  });

  it("applies the last of duplicate descriptors in one provideAll", () => {
    class C {
      readonly n: number;
      constructor(n: number) {
        this.n = n;
      }
    }
    const root = createRootScope();
    try {
      root.provideAll([createDescriptor(C, 1), createDescriptor(C, 2)]);
      expect(root.get(C).n).toBe(2);
    } finally {
      root.dispose();
    }
  });

  it("keeps constructing the previous version after a failed replaceService", () => {
    class Old {
      readonly version = 1;
    }
    class Broken extends Old {
      constructor() {
        super();
        throw new Error("broken");
      }
    }
    const root = createRootScope();
    try {
      root.provide(Old);
      root.get(Old);
      expect(() => replaceService(Old, Broken)).toThrow("broken");
      expect(root.get(Old)).toBeInstanceOf(Old);
      expect(root.createInstance(Old)).toBeInstanceOf(Old);
    } finally {
      root.dispose();
    }
  });
});

describe("transactions", () => {
  it("keeps registrations consistent when releasing a previous instance throws", () => {
    abstract class Base {}
    class A extends Base {
      constructor() {
        super();
        onScopeDispose(() => {
          throw new Error("cleanup failed");
        });
      }
    }
    class A2 extends Base {}
    const root = createRootScope();
    try {
      root.provide(Base, A);
      root.get(Base);
      expect(() => root.provide(Base, A2)).toThrow("cleanup failed");
      expect(root.get(Base)).toBeInstanceOf(A2);
      class A3 extends A2 {}
      expect(replaceService(A2, A3)).toBe(1);
      expect(root.get(Base)).toBeInstanceOf(A3);
    } finally {
      root.dispose();
    }
  });

  it("undoes a provide made inside a constructor whose provide fails", () => {
    const events: string[] = [];
    class Side {
      constructor() {
        onScopeDispose(() => events.push("dispose:side"));
      }
    }
    const root = createRootScope();
    class Bad {
      constructor() {
        root.provide(Side);
        root.get(Side);
        throw new Error("bad");
      }
    }
    try {
      expect(() => root.provideAll([Bad])).toThrow("bad");
      expect(() => root.get(Side)).toThrow("unknown service");
      expect(events).toEqual(["dispose:side"]);
    } finally {
      root.dispose();
    }
  });
});

describe("hot runtime staging", () => {
  it("shows an unapplied implementation only to code running in module evaluations", () => {
    const listeners = new Map<string, (payload: object) => void>();
    const hot = {
      data: {},
      ownerPath: "/staging-a.ts",
      on: (event: string, listener: (payload: object) => void) => void listeners.set(event, listener),
      send: () => {},
      invalidate: () => {},
    };
    const evaluate = (value: number) => {
      const module = createHotModule(hot as never, "/staging-a.ts", "f=f:f", false, "h", () => []);
      const f = module.fn("f", () => value);
      const seenInEvaluation = f();
      module.commit();
      return { f, seenInEvaluation };
    };
    const first = evaluate(1);
    const payload = { updates: [{ acceptedPath: "/staging-other.ts" }] };
    listeners.get("vite:beforeUpdate")!(payload);
    const second = evaluate(2);
    expect(second.seenInEvaluation).toBe(2);
    expect(first.f()).toBe(1);
    listeners.get("vite:afterUpdate")!(payload);
    expect(first.f()).toBe(2);
  });
});

describe("optional dependencies", () => {
  it("rebuilds a service whose optional dependency is provided later", () => {
    class Auth {}
    class Consumer {
      readonly auth = optionalInject(Auth);
    }
    const root = createRootScope();
    try {
      root.provide(Consumer);
      expect(root.get(Consumer).auth).toBeUndefined();
      root.provide(Auth);
      expect(root.get(Consumer).auth).toBeInstanceOf(Auth);
    } finally {
      root.dispose();
    }
  });
});

describe("plain data comparison", () => {
  it("treats holes, symbol keys and accessors as differences", () => {
    const key = Symbol("k");
    expect(isSamePlainData(Array(1), [42])).toBe(false);
    expect(isSamePlainData({ [key]: 1 }, { [key]: 2 })).toBe(false);
    expect(isSamePlainData({ get a() { return 1; } }, { a: 1 })).toBe(false);
    expect(isSamePlainData({ a: [1, { b: "c" }] }, { a: [1, { b: "c" }] })).toBe(true);
  });
});
