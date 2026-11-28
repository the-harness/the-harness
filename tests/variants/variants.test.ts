import { describe, expect, it } from "vite-plus/test";
import {
  DuplicateFieldError,
  DuplicateVariantError,
  ExtensibleFields,
  ExtensibleVariants,
  variant,
  type SerializedVariant,
} from "../../packages/variants/src/index.ts";

function register(name: string, ctor: new (...args: never[]) => ExtensibleVariants): void {
  variant(name)(ctor as never, {} as ClassDecoratorContext);
}

class Meta extends ExtensibleFields {}
const labelField = Meta.defineField<string, typeof Meta>("tests:variants:label");
const countField = Meta.defineField<number, typeof Meta>("tests:variants:count");

class Root extends ExtensibleVariants<{ readonly meta: Meta }> {
  declare readonly name: string;
  readonly meta: Meta = new Meta();
}
class Child extends Root {
  declare readonly childOnly: boolean;
}
class Leaf extends Child {
  declare readonly leafOnly: string;
}
class Unregistered extends ExtensibleVariants {}

describe("extensible fields", () => {
  it("scopes, isolates and validates field keys", () => {
    expect(() => Meta.defineField<number, typeof Meta>("unscoped")).toThrow(
      'Field name "unscoped" must be scoped as "<author>:<package>:<name>"',
    );
    expect(() => Meta.defineField<number, typeof Meta>("tests:variants:label")).toThrow(
      DuplicateFieldError,
    );

    class OtherMeta extends ExtensibleFields {}
    const otherLabel = OtherMeta.defineField<string, typeof OtherMeta>("tests:variants:label");
    const meta = new Meta({ [labelField.name]: "value", skipped: undefined });
    meta.set(countField, 2);

    expect(meta.get(labelField)).toBe("value");
    expect(meta.get(countField)).toBe(2);
    expect(meta.has(labelField)).toBe(true);
    expect(meta.delete(countField)).toBe(true);
    expect(meta.delete(countField)).toBe(false);
    expect(meta.get(countField)).toBeUndefined();
    expect(new OtherMeta().get(otherLabel)).toBeUndefined();
    expect(() => Meta.defineField<number, typeof Meta>("tests:variants:label")).toThrow(
      'Duplicate field name: "tests:variants:label"',
    );
  });

  it("copies, serializes and deserializes only defined values", () => {
    const meta = new Meta();
    meta.set(labelField, "a");
    meta.set(countField, 0);
    const copy = new Meta(meta);

    expect(copy.get(labelField)).toBe("a");
    expect(copy.get(countField)).toBe(0);
    expect(ExtensibleFields.serialize(copy)).toEqual({
      "tests:variants:label": "a",
      "tests:variants:count": 0,
    });
    expect(
      ExtensibleFields.serialize(copy, (value) =>
        typeof value === "string" ? value.toUpperCase() : value,
      ),
    ).toEqual({ "tests:variants:label": "A", "tests:variants:count": 0 });

    const restored = Meta.deserialize({
      "tests:variants:label": "A",
      "tests:variants:count": 3,
    });
    expect(restored).toBeInstanceOf(Meta);
    expect(restored.get(labelField)).toBe("A");
    expect(restored.get(countField)).toBe(3);
    expect(Meta.deserialize(undefined)).toEqual(new Meta());
  });
});

describe("extensible variants", () => {
  it("registers variant names and rejects invalid or duplicate names", () => {
    expect(() => variant("invalid")).toThrow(
      'Variant name "invalid" must be scoped as "<author>:<package>:<name>"',
    );

    class First extends ExtensibleVariants {}
    class Second extends ExtensibleVariants {}
    register("tests:variants:duplicate", First);
    expect(() => register("tests:variants:duplicate", First)).not.toThrow();
    expect(() => register("tests:variants:duplicate", Second)).toThrow(DuplicateVariantError);
    expect(() => register("tests:variants:duplicate", Second)).toThrow(
      'Duplicate variant name: "tests:variants:duplicate"',
    );
  });

  it("creates instances by chain and round-trips nested fields and variants", () => {
    register("tests:variants:root", Root);
    register("tests:variants:child", Child);
    register("tests:variants:leaf", Leaf);

    const meta = new Meta();
    meta.set(labelField, "hello");
    meta.set(countField, 2);
    const leaf = Leaf.create({
      name: "leaf",
      childOnly: true,
      leafOnly: "leaf",
      meta,
    });

    expect(leaf).toBeInstanceOf(Leaf);
    expect(leaf.meta).toBe(meta);
    expect(ExtensibleVariants.getVariantChain(leaf)).toEqual([
      "tests:variants:root",
      "tests:variants:child",
      "tests:variants:leaf",
    ]);

    const serialized = ExtensibleVariants.serialize(leaf);
    expect(serialized).toEqual({
      $variants: ["tests:variants:root", "tests:variants:child", "tests:variants:leaf"],
      name: "leaf",
      childOnly: true,
      leafOnly: "leaf",
      meta: {
        "tests:variants:label": "hello",
        "tests:variants:count": 2,
      },
    });

    const restored = ExtensibleVariants.deserialize(serialized) as Leaf;
    expect(restored).toBeInstanceOf(Leaf);
    expect(restored.meta).toBeInstanceOf(Meta);
    expect(restored.meta?.get(labelField)).toBe("hello");
    expect(restored.meta?.get(countField)).toBe(2);
    expect(ExtensibleVariants.serialize(restored)).toEqual(serialized);
  });

  it("falls back to a known base variant and rejects unknown chains or wrong bases", () => {
    register("tests:variants:root", Root);
    const withUnknownLeaf: SerializedVariant = {
      $variants: ["tests:variants:root", "tests:variants:removed"],
      name: "fallback",
    };
    const fallback = ExtensibleVariants.deserialize(withUnknownLeaf) as Root;
    expect(fallback).toBeInstanceOf(Root);
    expect(fallback.name).toBe("fallback");

    expect(() =>
      ExtensibleVariants.deserialize({ $variants: ["tests:variants:removed"], name: "x" }),
    ).toThrow("Unknown variant chain: tests:variants:removed");
    expect(() => Child.deserialize({ $variants: ["tests:variants:root"], name: "x" })).toThrow(
      TypeError,
    );
  });

  it("rejects serializing variants that were never registered", () => {
    const value = new Unregistered();
    expect(() => ExtensibleVariants.serialize(value)).toThrow(
      'Variant class "Unregistered" is not registered with @variant()',
    );
  });
});
