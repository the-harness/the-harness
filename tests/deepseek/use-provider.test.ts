import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type DeepSeekModule = typeof import("../../packages/deepseek/src/index.ts");
type ReactivityModule = typeof import("reactivity");
type Scope = import("../../packages/di/src/index.ts").Scope;

let harness: HarnessModules;
let di: DiModule;
let modelProvider: ModelProviderModule;
let deepseek: DeepSeekModule;
let reactivity: ReactivityModule;

const fakeFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("network is disabled in this test");
});

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, modelProvider, deepseek, reactivity] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<DeepSeekModule>("/packages/deepseek/src/index.ts"),
    harness.load<ReactivityModule>("reactivity"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createRoot() {
  const root = di.createRootScope({ id: "root" });
  root.provide(modelProvider.ProviderManager);
  return { root, manager: root.get(modelProvider.ProviderManager) };
}

describe("useDeepSeekProvider", () => {
  it("disposes the provider scope with the caller's EffectScope", () => {
    const { root, manager } = createRoot();
    let provider: Scope | undefined;
    const caller = root.run(() => {
      const scope = reactivity.effectScope();
      scope.run(() => {
        provider = deepseek.useDeepSeekProvider({ fetch: fakeFetch });
      });
      return scope;
    });
    expect(manager.providers.get("deepseek")).toBe(provider);
    expect(provider!.isDisposed).toBe(false);

    caller.stop();

    expect(provider!.isDisposed).toBe(true);
    expect(manager.providers.has("deepseek")).toBe(false);
    root.dispose();
  });

  it("keeps exactly one provider when the setup re-runs", async () => {
    const { root, manager } = createRoot();
    const trigger = reactivity.ref(0);
    const created: Scope[] = [];
    root.setup(() => {
      void trigger.value;
      created.push(deepseek.useDeepSeekProvider({ fetch: fakeFetch }));
    });
    expect(created).toHaveLength(1);

    trigger.value++;
    await vi.waitFor(() => expect(created).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toHaveLength(2);
    expect(created[0]!.isDisposed).toBe(true);
    expect(created[1]!.isDisposed).toBe(false);
    expect([...manager.providers.keys()]).toEqual(["deepseek"]);
    expect(manager.providers.get("deepseek")).toBe(created[1]);
    root.dispose();
  });

  it("throws outside an EffectScope", () => {
    expect(() => deepseek.useDeepSeekProvider({ fetch: fakeFetch })).toThrow(
      "useDeepSeekProvider() requires an active EffectScope",
    );
  });
});
