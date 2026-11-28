import { describe, expect, it } from "vite-plus/test";
import {
  nextTick,
  onScopeDispose,
  watchEffect,
} from "../../packages/di/node_modules/reactivity/dist/index.js";
import {
  createDescriptor,
  createRootScope,
  CurrentScope,
  inject,
  type Scope,
} from "../../packages/di/src/index.ts";

interface LegacyOptions {
  readonly id?: string;
  readonly services?: Parameters<Scope["provideAll"]>[0];
  readonly setup?: () => void;
}

function createRoot(options: LegacyOptions = {}): Scope {
  const scope = createRootScope({ id: options.id });
  if (options.services) scope.provideAll(options.services);
  if (options.setup) scope.setup(options.setup);
  return scope;
}

function createChild(parent: Scope, options: LegacyOptions = {}): Scope {
  const child = parent.createChild({ id: options.id });
  if (options.services) child.provideAll(options.services);
  if (options.setup) child.setup(options.setup);
  return child;
}

describe("scope tree and service ownership", () => {
  it("constructs descriptors eagerly in dependency order and shares ancestors with children", () => {
    const events: string[] = [];
    abstract class LoggerService {
      abstract readonly name: string;
    }
    abstract class AgentService {
      abstract readonly name: string;
      abstract readonly logger: LoggerService;
    }

    class Logger extends LoggerService {
      readonly name = "logger";
      constructor() {
        super();
        events.push("logger");
      }
    }
    class Agent extends AgentService {
      readonly name: string;
      readonly logger: LoggerService;
      constructor(name: string) {
        super();
        this.name = name;
        this.logger = inject(LoggerService);
        events.push(`agent:${name}`);
      }
    }

    const root = createRoot({ id: "app", services: [[LoggerService, Logger]] });
    try {
      const session = createChild(root, {
        id: "session",
        services: [[AgentService, createDescriptor(Agent, "agent-a")]],
      });

      expect(events).toEqual(["logger", "agent:agent-a"]);
      expect(root.isRoot).toBe(true);
      expect(root.root).toBe(root);
      expect(session.isRoot).toBe(false);
      expect(session.parent).toBe(root);
      expect(session.root).toBe(root);
      expect(root.children.get("session")).toBe(session);
      expect(session.get(AgentService).name).toBe("agent-a");
      expect(session.get(AgentService).logger).toBe(root.get(LoggerService));
      expect(session.get(LoggerService)).toBe(root.get(LoggerService));
      expect(() => root.get(AgentService)).toThrow("unknown service 'AgentService'");
    } finally {
      root.dispose();
    }
  });

  it("tracks service substitutions from reactive effects", async () => {
    abstract class ValueService {
      abstract readonly value: string;
    }
    class V extends ValueService {
      readonly value: string;
      constructor(value: string) {
        super();
        this.value = value;
      }
    }

    const root = createRoot({
      services: [[ValueService, createDescriptor(V, "v1")]],
    });
    const seen: string[] = [];
    const stop = watchEffect(() => {
      seen.push(root.get(ValueService).value);
    });
    try {
      expect(seen).toEqual(["v1"]);

      root.provide(ValueService, createDescriptor(V, "v2"));
      await nextTick();

      expect(seen).toEqual(["v1", "v2"]);
    } finally {
      stop();
      root.dispose();
    }
  });

  it("keeps roots, siblings, and generated child ids isolated", () => {
    abstract class ValueService {
      abstract readonly value: number;
    }
    class Value extends ValueService {
      readonly value: number;
      constructor(value: number) {
        super();
        this.value = value;
      }
    }

    const first = createRoot({
      services: [[ValueService, createDescriptor(Value, 1)]],
    });
    const second = createRoot({
      services: [[ValueService, createDescriptor(Value, 2)]],
    });
    try {
      const childA = createChild(first, {
        services: [[ValueService, createDescriptor(Value, 10)]],
      });
      const childB = createChild(first, {
        services: [[ValueService, createDescriptor(Value, 20)]],
      });
      const generated = createChild(first);

      expect(first.get(ValueService).value).toBe(1);
      expect(second.get(ValueService).value).toBe(2);
      expect(childA.get(ValueService).value).toBe(10);
      expect(childB.get(ValueService).value).toBe(20);
      expect(generated.get(ValueService)).toBe(first.get(ValueService));
      expect(new Set([childA.id, childB.id, generated.id]).size).toBe(3);
      expect(generated.id).toMatch(/^scope-\d+$/);
      expect(() => createChild(first, { id: "child-a" })).not.toThrow();
      expect(() => createChild(first, { id: "child-a" })).toThrow(
        "scope 'root' already has a child with id 'child-a'",
      );

      first.dispose();
      expect(second.get(ValueService).value).toBe(2);
      expect(second.isDisposed).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

describe("scope lifecycle", () => {
  it("tears down descendants and services in reverse construction order", () => {
    const events: string[] = [];
    abstract class RootService {
      abstract readonly name: string;
    }
    abstract class SessionService {
      abstract readonly name: string;
    }
    abstract class NestedService {
      abstract readonly name: string;
    }

    class RootTracked extends RootService {
      readonly name = "root";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:root"));
      }
    }
    class RootSessionTracked extends SessionService {
      readonly name = "session-root";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:session-root"));
      }
    }
    class SessionTracked extends SessionService {
      readonly name = "session";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:session"));
      }
    }
    class NestedTracked extends NestedService {
      readonly name = "nested";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:nested"));
      }
    }

    const root = createRoot({
      id: "root",
      services: [
        [RootService, RootTracked],
        [SessionService, RootSessionTracked],
      ],
    });
    const session = createChild(root, {
      id: "session",
      services: [[SessionService, SessionTracked]],
    });
    createChild(session, {
      id: "nested",
      services: [[NestedService, NestedTracked]],
    });

    root.dispose();

    expect(events).toEqual([
      "dispose:nested",
      "dispose:session",
      "dispose:session-root",
      "dispose:root",
    ]);
    expect(root.isDisposed).toBe(true);
    expect(root.children.size).toBe(0);
    expect(session.isDisposed).toBe(true);
    root.dispose();
    expect(events).toHaveLength(4);
  });

  it("runs scope-level dispose callbacks once and rejects work after disposal", () => {
    const events: string[] = [];
    abstract class Named {
      abstract readonly name: string;
    }
    const scope = createRoot();

    scope.onDispose(() => events.push("first"));
    scope.onDispose(() => events.push("second"));
    scope.run(() => onScopeDispose(() => events.push("run")));

    scope.dispose();
    scope.dispose();

    expect(events).toEqual(["first", "second", "run"]);
    expect(scope.isDisposed).toBe(true);
    expect(() => scope.get(Named)).toThrow("scope 'root' has been disposed");
    expect(() => scope.run(() => undefined)).toThrow("scope 'root' has been disposed");
    expect(() => scope.onDispose(() => {})).toThrow("scope 'root' has been disposed");
    expect(() => scope.createChild()).toThrow("scope 'root' has been disposed");
    expect(() => scope.createInstance(class Value {})).toThrow("scope 'root' has been disposed");
    expect(() =>
      scope.provide(
        Named,
        class NamedImpl extends Named {
          name = "n";
        },
      ),
    ).toThrow("scope 'root' has been disposed");
    expect(() => scope.unprovide(Named)).toThrow("scope 'root' has been disposed");
  });

  it("detaches a disposed child while leaving the parent and siblings usable", () => {
    const events: string[] = [];
    abstract class Named {
      abstract readonly name: string;
    }
    abstract class ChildService {
      abstract readonly name: string;
    }
    class ParentService extends Named {
      readonly name = "parent";
    }
    class Child extends ChildService {
      readonly name = "child";
      constructor() {
        super();
        onScopeDispose(() => events.push("child-cleanup"));
      }
    }

    const parent = createRoot({
      services: [[Named, ParentService]],
    });
    const child = createChild(parent, { id: "child", services: [[ChildService, Child]] });
    const sibling = createChild(parent, { id: "sibling" });

    child.dispose();

    expect(events).toEqual(["child-cleanup"]);
    expect(parent.children.has("child")).toBe(false);
    expect(parent.get(Named).name).toBe("parent");
    expect(sibling.isDisposed).toBe(false);
    expect(() => child.get(ChildService)).toThrow("scope 'child' has been disposed");
    expect(() => child.createChild()).toThrow("scope 'child' has been disposed");

    parent.dispose();
    expect(sibling.isDisposed).toBe(true);
    expect(events).toEqual(["child-cleanup"]);
  });
});

describe("ICurrentScope", () => {
  it("creates child scopes attached to the scope that owns the service", () => {
    abstract class WorkerService {
      abstract readonly childId: string;
    }

    class Worker extends WorkerService {
      readonly childId: string;
      constructor() {
        super();
        const child = inject(CurrentScope).createChild({ id: "worker-child" });
        this.childId = child.id;
      }
    }

    const root = createRoot();
    const session = createChild(root, { id: "session", services: [[WorkerService, Worker]] });
    try {
      expect(session.get(WorkerService).childId).toBe("worker-child");
      expect(session.children.get("worker-child")?.parent).toBe(session);
      expect(() => session.get(CurrentScope).createChild({ id: "worker-child" })).toThrow(
        "scope 'session' already has a child with id 'worker-child'",
      );
      expect(() => root.get(WorkerService)).toThrow("unknown service 'WorkerService'");
    } finally {
      root.dispose();
    }
  });
});
