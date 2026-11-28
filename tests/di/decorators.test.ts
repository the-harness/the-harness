import { describe, expect, it } from "vite-plus/test";
import {
  createDescriptor,
  createRootScope,
  Descriptor,
  inject,
  isBaseServiceIdentifier,
} from "../../packages/di/src/index.ts";
import { resolveBaseServiceIdentifier, toDescriptor } from "../../packages/di/src/descriptors.ts";

class TaggedService {
  readonly tag: string;
  readonly extra?: string;

  constructor(tag: string, extra?: string) {
    this.tag = tag;
    this.extra = extra;
  }
}

describe("service identifiers", () => {
  it("deduplicates identifiers by name and keeps a stable printable name", () => {
    abstract class Named {
      abstract readonly name: string;
    }
    class Concrete extends Named {
      readonly name = "concrete";
    }

    expect(resolveBaseServiceIdentifier(Concrete)).toBe(Named);
    expect(resolveBaseServiceIdentifier(Named)).toBe(Named);
    expect(isBaseServiceIdentifier(Named)).toBe(true);
    expect(isBaseServiceIdentifier(Concrete)).toBe(false);
    expect(isBaseServiceIdentifier(undefined)).toBe(false);
    expect(Named.name).toBe("Named");
    expect(String(Named)).toContain("class Named");
    expect(createDescriptor(Concrete).ctor).toBe(createDescriptor(Concrete).ctor);
  });

  it("records constructor parameters in index order even though decorators apply backwards", () => {
    const events: string[] = [];
    abstract class Dependency {
      abstract readonly value: string;
    }
    class DependencyImpl extends Dependency {
      readonly value = "dep";
    }
    abstract class Consumer {
      abstract readonly label: string;
    }
    class ConsumerImpl extends Consumer {
      readonly label: string;
      readonly dependency: Dependency;

      constructor(first: string, second: string) {
        super();
        this.dependency = inject(Dependency);
        this.label = `${first}:${second}:${this.dependency.value}`;
        events.push(this.label);
      }
    }

    const root = createRootScope();
    root.provideAll([
      [Dependency, DependencyImpl],
      [Consumer, createDescriptor(ConsumerImpl, "a", "b")],
    ]);
    try {
      expect(root.get(Consumer).label).toBe("a:b:dep");
      expect(events).toEqual(["a:b:dep"]);
    } finally {
      root.dispose();
    }
  });

  it("inherits dependency metadata only until a subclass declares its own", () => {
    abstract class Base {
      abstract readonly value: string;
    }
    class Middle extends Base {
      readonly value: string = "middle";
    }
    class Leaf extends Middle {
      override readonly value: string = "leaf";
    }

    expect(resolveBaseServiceIdentifier(Middle)).toBe(Base);
    expect(resolveBaseServiceIdentifier(Leaf)).toBe(Base);

    const root = createRootScope();
    root.provideAll([[Base, Leaf]]);
    try {
      expect(root.get(Base)).toBeInstanceOf(Leaf);
      expect(root.get(Base).value).toBe("leaf");
      expect(() => root.provide(Base, class Unrelated {})).toThrow(
        "does not extend base service 'Base'",
      );
    } finally {
      root.dispose();
    }
  });

  it("rejects being used anywhere but as a constructor parameter", () => {
    abstract class Service {
      abstract readonly value: string;
    }
    class Implementation extends Service {
      readonly value = "impl";
    }

    expect(() => inject(Service)).toThrow(
      "inject(Service) can only be called synchronously inside a service constructor, createInstance(), or scope.run()",
    );

    const root = createRootScope();
    root.provideAll([[Service, Implementation]]);
    try {
      expect(root.run(() => inject(Service).value)).toBe("impl");
    } finally {
      root.dispose();
    }
  });
});

describe("service descriptors", () => {
  it("wraps constructors once and preserves explicit descriptors", () => {
    const explicit = createDescriptor(TaggedService, "agent", "extra");
    expect(explicit).toBeInstanceOf(Descriptor);
    expect(explicit.ctor).toBe(TaggedService);
    expect(explicit.staticArguments).toEqual(["agent", "extra"]);

    expect(toDescriptor(explicit)).toBe(explicit);
    const wrapped = toDescriptor(TaggedService);
    expect(wrapped).toBeInstanceOf(Descriptor);
    expect(wrapped.ctor).toBe(TaggedService);
    expect(wrapped.staticArguments).toEqual([]);
  });

  it("rejects registrations that are neither constructors nor descriptors", () => {
    expect(() => toDescriptor(42 as unknown as typeof TaggedService)).toThrow(
      "service registration must be a constructor or Descriptor",
    );
    expect(() => toDescriptor({} as unknown as typeof TaggedService)).toThrow(
      "service registration must be a constructor or Descriptor",
    );
  });
});
