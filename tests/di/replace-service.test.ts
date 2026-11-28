import {
  createDescriptor,
  createRootScope,
  inject,
  replaceService,
} from "../../packages/di/src/index.ts";
import { afterEach, describe, expect, it } from "vite-plus/test";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

describe("@harness/di replaceService", () => {
  it("replaces a single-class service implementation and cascades to dependents", () => {
    const disposed: string[] = [];

    class FooV1 {
      readonly version = 1;
      constructor(readonly scope = inject) {}
    }

    class FooWithDispose {
      readonly version = 1;
    }

    class Bar {
      readonly foo = inject(FooWithDispose);
      get version() {
        return this.foo.version;
      }
    }

    const root = createRootScope();
    cleanups.push(() => root.dispose());

    root.provideAll([FooWithDispose, Bar]);
    const bar1 = root.get(Bar);
    expect(bar1.version).toBe(1);

    class FooV2 {
      readonly version = 2;
    }

    const count = replaceService(FooWithDispose, FooV2 as unknown as typeof FooWithDispose);
    expect(count).toBe(1);

    const bar2 = root.get(Bar);
    expect(bar2).not.toBe(bar1);
    expect(bar2.version).toBe(2);
    expect(bar2.foo).toBeInstanceOf(FooV2);
    void disposed;
    void FooV1;
  });

  it("preserves staticArguments and supports chained replacements across multiple scopes", () => {
    class GreeterV1 {
      constructor(readonly prefix: string) {}
      greet(name: string) {
        return `${this.prefix}:${name}:v1`;
      }
    }

    class GreeterV2 {
      constructor(readonly prefix: string) {}
      greet(name: string) {
        return `${this.prefix}:${name}:v2`;
      }
    }

    class GreeterV3 {
      constructor(readonly prefix: string) {}
      greet(name: string) {
        return `${this.prefix}:${name}:v3`;
      }
    }

    const root = createRootScope();
    const child = root.createChild();
    cleanups.push(() => root.dispose());

    root.provide(GreeterV1, createDescriptor(GreeterV1, "root"));
    child.provide(GreeterV1, createDescriptor(GreeterV1, "child"));

    expect(root.get(GreeterV1).greet("a")).toBe("root:a:v1");
    expect(child.get(GreeterV1).greet("b")).toBe("child:b:v1");

    expect(replaceService(GreeterV1, GreeterV2)).toBe(2);
    expect(root.get(GreeterV1).greet("a")).toBe("root:a:v2");
    expect(child.get(GreeterV1).greet("b")).toBe("child:b:v2");

    expect(replaceService(GreeterV2, GreeterV3)).toBe(2);
    expect(root.get(GreeterV1).greet("a")).toBe("root:a:v3");
    expect(child.get(GreeterV1).greet("b")).toBe("child:b:v3");
  });

  it("rolls back cleanly when the replacement constructor throws", () => {
    class ServiceV1 {
      readonly value = "ok";
    }

    class BrokenV2 {
      constructor() {
        throw new Error("boom");
      }
    }

    class ServiceV3 {
      readonly value = "recovered";
    }

    const root = createRootScope();
    cleanups.push(() => root.dispose());
    root.provide(ServiceV1);
    expect(root.get(ServiceV1).value).toBe("ok");

    expect(() => replaceService(ServiceV1, BrokenV2 as unknown as typeof ServiceV1)).toThrow(
      "boom",
    );
    expect(root.get(ServiceV1).value).toBe("ok");

    expect(replaceService(ServiceV1, ServiceV3)).toBe(1);
    expect(root.get(ServiceV1).value).toBe("recovered");
  });
});
