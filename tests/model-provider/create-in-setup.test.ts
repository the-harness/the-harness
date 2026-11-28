import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let modelProvider: ModelProviderModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, modelProvider] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

describe("ProviderManager.create inside a setup", () => {
  it("does not re-run the setup when other providers are added or removed", () => {
    const root = di.createRootScope({ id: "root" });
    root.provide(modelProvider.ProviderManager);
    const manager = root.get(modelProvider.ProviderManager);
    let runs = 0;
    root.setup(() => {
      runs++;
      di.inject(modelProvider.ProviderManager).create({ id: "a" });
    });
    const first = manager.providers.get("a");

    manager.create({ id: "b" }).dispose();

    expect(runs).toBe(1);
    expect(manager.providers.get("a")).toBe(first);
    expect(() => root.dispose()).not.toThrow();
  });
});
