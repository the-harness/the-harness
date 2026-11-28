import { describe, expect, it } from "vite-plus/test";
import { onScopeDispose } from "../../packages/di/node_modules/reactivity/dist/index.js";
import {
  createDescriptor,
  createRootScope,
  CyclicDependencyError,
  inject,
  InstantiationService,
  replaceService,
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

describe("provide and unprovide cascades", () => {
  it("rebuilds dependents against a replacement and cleans up the previous generation", () => {
    const events: string[] = [];
    abstract class ConfigService {
      abstract readonly value: string;
    }
    abstract class AgentService {
      abstract readonly config: ConfigService;
    }

    class Config extends ConfigService {
      readonly value: string;
      constructor(value: string) {
        super();
        this.value = value;
        events.push(`construct:config:${value}`);
        onScopeDispose(() => events.push(`dispose:config:${value}`));
      }
    }
    class Agent extends AgentService {
      readonly config: ConfigService;
      constructor() {
        super();
        this.config = inject(ConfigService);
        events.push(`construct:agent:${this.config.value}`);
        onScopeDispose(() => events.push(`dispose:agent:${this.config.value}`));
      }
    }

    const root = createRoot({
      services: [
        [ConfigService, createDescriptor(Config, "v1")],
        [AgentService, Agent],
      ],
    });
    try {
      const first = root.get(AgentService);
      expect(first.config.value).toBe("v1");
      expect(events).toEqual(["construct:config:v1", "construct:agent:v1"]);

      root.provide(ConfigService, createDescriptor(Config, "v2"));

      const second = root.get(AgentService);
      expect(second).not.toBe(first);
      expect(second.config.value).toBe("v2");
      expect(second.config).toBe(root.get(ConfigService));
      expect(events).toEqual([
        "construct:config:v1",
        "construct:agent:v1",
        "construct:config:v2",
        "construct:agent:v2",
        "dispose:config:v1",
        "dispose:agent:v1",
      ]);
    } finally {
      root.dispose();
    }
  });

  it("reports a still-required dependency while keeping the scope usable", () => {
    abstract class ConfigService {
      abstract readonly value: string;
    }
    abstract class AgentService {
      abstract readonly config: ConfigService;
    }

    class Config extends ConfigService {
      readonly value = "kept";
    }
    class Agent extends AgentService {
      readonly config: ConfigService;
      constructor() {
        super();
        this.config = inject(ConfigService);
      }
    }

    const root = createRoot({
      services: [
        [ConfigService, Config],
        [AgentService, Agent],
      ],
    });
    try {
      expect(root.get(AgentService).config.value).toBe("kept");

      expect(() => root.unprovide(ConfigService)).toThrow("unknown service 'ConfigService'");
      expect(root.get(ConfigService).value).toBe("kept");
      expect(root.get(AgentService).config).toBe(root.get(ConfigService));

      root.unprovide(AgentService);
      root.unprovide(ConfigService);
      expect(() => root.get(AgentService)).toThrow("unknown service 'AgentService'");
    } finally {
      root.dispose();
    }
  });

  it("removes consumers before their dependency and ignores unknown removals", () => {
    const events: string[] = [];
    abstract class ConfigService {
      abstract readonly value: string;
    }
    abstract class AgentService {
      abstract readonly config: ConfigService;
    }
    abstract class UnknownService {
      abstract readonly value: string;
    }

    class Config extends ConfigService {
      readonly value = "config";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:config"));
      }
    }
    class Agent extends AgentService {
      readonly config: ConfigService;
      constructor() {
        super();
        this.config = inject(ConfigService);
        onScopeDispose(() => events.push("dispose:agent"));
      }
    }

    const root = createRoot({
      services: [
        [ConfigService, Config],
        [AgentService, Agent],
      ],
    });
    root.unprovide(UnknownService);
    root.unprovide(UnknownService);
    expect(events).toEqual([]);

    root.unprovide(AgentService);
    expect(events).toEqual(["dispose:agent"]);
    expect(() => root.get(AgentService)).toThrow("unknown service 'AgentService'");

    root.unprovide(ConfigService);
    expect(events).toEqual(["dispose:agent", "dispose:config"]);
    expect(() => root.get(ConfigService)).toThrow("unknown service 'ConfigService'");

    root.unprovide(ConfigService);
    expect(events).toEqual(["dispose:agent", "dispose:config"]);
    root.dispose();
  });

  it("eagerly registers a service again after the previous cleanup throws", () => {
    const events: string[] = [];
    abstract class Service {
      abstract readonly version: string;
    }
    class RetiredService extends Service {
      readonly version = "retired";

      constructor() {
        super();
        onScopeDispose(() => {
          throw new Error("retired service cleanup failed");
        });
      }
    }
    class Replacement extends Service {
      constructor(readonly version = "replacement") {
        super();
        events.push(`start:${version}`);
        onScopeDispose(() => events.push(`stop:${version}`));
      }
    }
    class HotReplacement extends Replacement {
      constructor() {
        super("hot");
      }
    }

    const root = createRoot({ services: [[Service, RetiredService]] });
    try {
      expect(() => root.unprovide(Service)).toThrow("retired service cleanup failed");
      expect(() => root.get(Service)).toThrow("unknown service 'Service'");

      root.provide(Service, Replacement);
      expect(events).toEqual(["start:replacement"]);

      expect(replaceService(Replacement, HotReplacement)).toBe(1);
      // The replacement is built before the previous instance stops.
      expect(events).toEqual(["start:replacement", "start:hot", "stop:replacement"]);
      expect(root.get(Service).version).toBe("hot");
    } finally {
      root.dispose();
    }
    expect(events.at(-1)).toBe("stop:hot");
  });
});

describe("transactional registration", () => {
  it("rolls back every entry when construction fails midway", () => {
    const events: string[] = [];
    abstract class FirstService {
      abstract readonly value: string;
    }
    abstract class SecondService {
      abstract readonly value: string;
    }
    abstract class KeptService {
      abstract readonly value: string;
    }

    class Kept extends KeptService {
      readonly value = "first";
    }
    class First extends FirstService {
      readonly value = "first";
      constructor() {
        super();
        onScopeDispose(() => events.push("dispose:first"));
      }
    }
    class Boom extends SecondService {
      readonly value = "boom";
      constructor() {
        super();
        throw new Error("transaction boom");
      }
    }

    const root = createRoot({ services: [[KeptService, Kept]] });
    try {
      expect(() =>
        root.provideAll([
          [FirstService, First],
          [SecondService, Boom],
        ]),
      ).toThrow("transaction boom");

      expect(events).toEqual(["dispose:first"]);
      expect(() => root.get(FirstService)).toThrow("unknown service 'FirstService'");
      expect(() => root.get(SecondService)).toThrow("unknown service 'SecondService'");
      expect(root.get(KeptService).value).toBe("first");
    } finally {
      root.dispose();
    }
  });

  it("validates leading static arguments before constructing a service", () => {
    abstract class Dependency {
      abstract readonly value: string;
    }
    abstract class ConsumerService {
      abstract readonly label: string;
      abstract readonly dependency: Dependency;
    }
    class DependencyImpl extends Dependency {
      readonly value = "dep";
    }
    class Consumer extends ConsumerService {
      readonly label: string;
      readonly dependency: Dependency;
      constructor(first: string, second: string) {
        super();
        this.dependency = inject(Dependency);
        this.label = `${first}:${second}`;
      }
    }

    const root = createRoot({
      services: [
        [Dependency, DependencyImpl],
        [ConsumerService, createDescriptor(Consumer, "first", "extra")],
      ],
    });
    try {
      expect(root.get(ConsumerService).label).toBe("first:extra");
      expect(root.get(ConsumerService).dependency).toBe(root.get(Dependency));
      expect(() =>
        root.provide(ConsumerService, DependencyImpl as unknown as typeof Consumer),
      ).toThrow("does not extend base service 'ConsumerService'");
    } finally {
      root.dispose();
    }
  });
});

describe("cyclic dependencies", () => {
  it("reports direct and indirect cycles with the construction path", () => {
    abstract class SelfService {
      abstract readonly value: string;
    }
    class Self extends SelfService {
      readonly value = "self";
      constructor() {
        super();
        inject(SelfService);
      }
    }
    expect(() => createRoot({ services: [[SelfService, Self]] })).toThrow(CyclicDependencyError);
    try {
      createRoot({ services: [[SelfService, Self]] });
    } catch (error) {
      expect(error).toBeInstanceOf(CyclicDependencyError);
      expect((error as CyclicDependencyError).path).toEqual(["SelfService", "SelfService"]);
    }

    abstract class AService {
      abstract readonly value: string;
    }
    abstract class BService {
      abstract readonly value: string;
    }
    class A extends AService {
      readonly value = "a";
      constructor() {
        super();
        inject(BService);
      }
    }
    class B extends BService {
      readonly value = "b";
      constructor() {
        super();
        inject(AService);
      }
    }
    try {
      createRoot({
        services: [
          [AService, A],
          [BService, B],
        ],
      });
      expect.unreachable("a cyclic graph must not be constructed");
    } catch (error) {
      expect(error).toBeInstanceOf(CyclicDependencyError);
      expect((error as CyclicDependencyError).path).toEqual(["AService", "BService", "AService"]);
      expect((error as Error).message).toMatch(/cyclic dependency between services/i);
    }
  });

  it("detects a cycle that crosses a parent/child boundary and recovers afterwards", () => {
    abstract class ValueService {
      abstract readonly value: string;
    }
    abstract class BService {
      abstract readonly value: string;
    }
    class ParentA extends ValueService {
      readonly value = "parent-a";
    }
    class ChildA extends ValueService {
      readonly value = "child-a";
      constructor() {
        super();
        inject(BService);
      }
    }
    class ChildB extends BService {
      readonly value = "child-b";
      constructor() {
        super();
        inject(ValueService);
      }
    }

    const root = createRoot({ services: [[ValueService, ParentA]] });
    try {
      expect(() =>
        createChild(root, {
          services: [
            [ValueService, ChildA],
            [BService, ChildB],
          ],
        }),
      ).toThrow(CyclicDependencyError);
      expect(root.get(ValueService).value).toBe("parent-a");
    } finally {
      root.dispose();
    }

    const recovered = createRoot({ services: [[ValueService, ParentA]] });
    try {
      expect(recovered.get(ValueService).value).toBe("parent-a");
    } finally {
      recovered.dispose();
    }
  });
});

describe("IInstantiationService", () => {
  it("constructs descriptors with static arguments and resolves dependencies from the scope", () => {
    const events: string[] = [];
    abstract class Dependency {
      abstract readonly value: string;
    }
    class Dep extends Dependency {
      readonly value = "dep";
    }
    class Helper {
      readonly label: string;
      readonly dep: Dependency;
      constructor(label: string) {
        this.label = label;
        this.dep = inject(Dependency);
        events.push(`helper:${label}:${this.dep.value}`);
        onScopeDispose(() => events.push(`dispose-helper:${label}`));
      }
    }

    const root = createRoot({ services: [[Dependency, Dep]] });
    try {
      const helper = root.createInstance(createDescriptor(Helper, "static"));
      expect(helper.label).toBe("static");
      expect(helper.dep).toBe(root.get(Dependency));
      expect(root.get(InstantiationService)).toBe(root.get(InstantiationService));
      expect(events).toEqual(["helper:static:dep"]);

      const direct = root.createInstance(Helper, "direct");
      expect(direct.label).toBe("direct");
      expect(events).toEqual(["helper:static:dep", "helper:direct:dep"]);
    } finally {
      root.dispose();
    }
    expect(events).toEqual([
      "helper:static:dep",
      "helper:direct:dep",
      "dispose-helper:static",
      "dispose-helper:direct",
    ]);
  });

  it("ties instances created by a service to that service's lifetime", () => {
    const events: string[] = [];
    abstract class HostService {
      abstract readonly value: string;
    }

    class Helper {
      constructor() {
        onScopeDispose(() => events.push("dispose-helper"));
      }
    }
    class Host extends HostService {
      readonly value: string;
      constructor() {
        super();
        this.value = "host";
        inject(InstantiationService).createInstance(Helper);
        onScopeDispose(() => events.push("dispose-host"));
      }
    }

    const root = createRoot({ services: [[HostService, Host]] });
    try {
      root.get(HostService);
      expect(events).toEqual([]);

      root.unprovide(HostService);
      root.provide(HostService, Host);

      expect(events).toEqual(["dispose-helper", "dispose-host"]);
      expect(root.get(HostService).value).toBe("host");
    } finally {
      root.dispose();
    }
    expect(events).toEqual(["dispose-helper", "dispose-host", "dispose-helper", "dispose-host"]);
  });

  it("rejects extra static arguments that would land on a service parameter", () => {
    abstract class Dependency {
      abstract readonly value: string;
    }
    abstract class ConsumerService {
      abstract readonly label: string;
    }
    class Dep extends Dependency {
      readonly value = "dep";
    }
    class Consumer extends ConsumerService {
      readonly label: string;
      readonly dependency: Dependency;
      constructor(first: string, second: string) {
        super();
        this.label = `${first}:${second}`;
        this.dependency = inject(Dependency);
      }
    }

    const root = createRoot({ services: [[Dependency, Dep]] });
    try {
      const consumer = root.createInstance(createDescriptor(Consumer, "a", "b"));
      expect(consumer.label).toBe("a:b");
      expect(consumer.dependency).toBe(root.get(Dependency));
      expect(() => root.provide(ConsumerService, Dep as unknown as typeof Consumer)).toThrow(
        "does not extend base service 'ConsumerService'",
      );
    } finally {
      root.dispose();
    }
  });
});
