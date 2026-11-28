import { describe, expect, it } from "vite-plus/test";
import {
  beginModuleEvaluation,
  endModuleEvaluation,
} from "../../packages/hot/src/index.ts";
import {
  DuplicateFieldError,
  DuplicateVariantError,
  ExtensibleFields,
  ExtensibleVariants,
  variant,
  type SerializedVariant,
} from "../../packages/variants/src/index.ts";

function evaluate<T>(module: string | undefined, define: () => T): T {
  if (module === undefined) return define();
  beginModuleEvaluation(module);
  try {
    return define();
  } finally {
    endModuleEvaluation(module);
  }
}

function defineGreeting(module: string | undefined, version: string) {
  return evaluate(module, () => {
    abstract class Message extends ExtensibleVariants {
      declare readonly text: string;
    }
    class Greeting extends Message {
      describe(): string {
        return `${version}:${this.text}`;
      }
    }
    variant("test:hot:greeting")(Greeting as never);
    return { Message, Greeting };
  });
}

describe("variant hot updates", () => {
  const v1 = defineGreeting("/greeting.ts", "v1");
  const v2 = defineGreeting("/greeting.ts", "v2");

  it("treats instances of every version of a registered variant as instances of every version", () => {
    const old = v1.Greeting.create({ text: "hi" });
    const next = v2.Greeting.create({ text: "hi" });
    expect(old).toBeInstanceOf(v2.Greeting);
    expect(next).toBeInstanceOf(v1.Greeting);
    expect({ text: "hi" }).not.toBeInstanceOf(v2.Greeting);
  });

  it("creates and deserializes the latest version from any version", () => {
    expect(v1.Greeting.create({ text: "hi" }).describe()).toBe("v2:hi");
    const raw = ExtensibleVariants.serialize(v1.Greeting.create({ text: "yo" }));
    const value = ExtensibleVariants.deserialize(raw as SerializedVariant);
    expect((value as InstanceType<typeof v2.Greeting>).describe()).toBe("v2:yo");
  });

  it("still rejects a name claimed by another module or outside a hot update", () => {
    expect(() => defineGreeting("/other.ts", "v3")).toThrow(DuplicateVariantError);
    expect(() => defineGreeting(undefined, "v3")).toThrow(DuplicateVariantError);
  });
});

describe("field hot updates", () => {
  class Meta extends ExtensibleFields {}

  it("returns the existing key when the defining module is re-evaluated", () => {
    const first = evaluate("/meta.ts", () => Meta.defineField<string>("test:hot:field"));
    const again = evaluate("/meta.ts", () => Meta.defineField<string>("test:hot:field"));
    expect(again).toBe(first);
    expect(() => evaluate("/other.ts", () => Meta.defineField("test:hot:field"))).toThrow(
      DuplicateFieldError,
    );
    expect(() => Meta.defineField("test:hot:field")).toThrow(DuplicateFieldError);
  });
});
