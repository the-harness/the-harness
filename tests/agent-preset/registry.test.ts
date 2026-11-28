import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type AgentPresetModule = typeof import("../../packages/agent-preset/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let presets: AgentPresetModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, presets] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<AgentPresetModule>("/packages/agent-preset/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function preset(id: string, setup: () => void = () => {}) {
  return { id, name: id, setup } as unknown as InstanceType<AgentPresetModule["AgentPreset"]>;
}

describe("agent preset registry", () => {
  it("selects the first preset as default, rejects duplicates and survives disposal", () => {
    const root = di.createRootScope();
    root.provideAll([presets.AgentPresetRegistry]);
    try {
      const registry = root.get(presets.AgentPresetRegistry);
      const first = preset("first");
      const second = preset("second");
      root.run(() => {
        registry.usePreset(first);
        registry.usePreset(second);
      });
      expect(registry.defaultId).toBe("first");
      expect([...registry.presets.keys()]).toEqual(["first", "second"]);
      expect(registry.presets.get("first")).toBe(first);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((registry.presets as Map<string, typeof first>).delete("first")).toBe(false);
      } finally {
        warn.mockRestore();
      }
      expect(() => root.run(() => registry.usePreset(preset("first")))).toThrow(
        "agent preset 'first' is already registered",
      );

      const child = root.createChild();
      child.provideAll([presets.AgentPresetRegistry]);
      const childRegistry = child.get(presets.AgentPresetRegistry);
      child.run(() => childRegistry.usePreset(preset("child")));
      expect(childRegistry.defaultId).toBe("child");
      child.dispose();
      expect(registry.defaultId).toBe("first");
      expect(registry.presets.size).toBe(2);
    } finally {
      root.dispose();
    }
  });

  it("keeps the reactive default in sync with scoped registrations", () => {
    const root = di.createRootScope();
    root.provideAll([presets.AgentPresetRegistry]);
    try {
      const registry = root.get(presets.AgentPresetRegistry);
      const observed: Array<[string | undefined, string[]]> = [];
      root.setup(() => {
        observed.push([registry.defaultId, [...registry.presets.keys()]]);
      });

      const first = root.createChild();
      first.run(() => registry.usePreset(preset("first")));
      const second = root.createChild();
      second.run(() => registry.usePreset(preset("second")));
      first.dispose();
      second.dispose();

      expect(observed).toEqual([
        [undefined, []],
        ["first", ["first"]],
        ["first", ["first", "second"]],
        ["second", ["second"]],
        [undefined, []],
      ]);
    } finally {
      root.dispose();
    }
  });
});
