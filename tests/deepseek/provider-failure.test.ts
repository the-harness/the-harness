import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type AuthModule = typeof import("../../packages/auth/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");
type DeepSeekModule = typeof import("../../packages/deepseek/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let auth: AuthModule;
let modelProvider: ModelProviderModule;
let deepseek: DeepSeekModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, auth, modelProvider, deepseek] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<AuthModule>("/packages/auth/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
    harness.load<DeepSeekModule>("/packages/deepseek/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

describe("useDeepSeekProvider failure", () => {
  it("releases the provider id when constructing its services throws, so a retry succeeds", () => {
    const root = di.createRootScope({ id: "root" });
    root.provide(modelProvider.ProviderManager);
    const manager = root.get(modelProvider.ProviderManager);
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ object: "list", data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let failAuth = true;
    class FlakyAuthService extends auth.AuthService {
      constructor() {
        super();
        if (failAuth) throw new Error("auth unavailable");
      }
      override authorize(): auth.AuthResult {
        return { headers: {} };
      }
    }
    const setup = () =>
      root.setup(() => {
        deepseek.useDeepSeekProvider({ auth: FlakyAuthService, fetch: fakeFetch });
      });

    expect(setup).toThrow("auth unavailable");
    expect(manager.providers.has("deepseek")).toBe(false);

    failAuth = false;
    setup();

    expect([...manager.providers.keys()]).toEqual(["deepseek"]);
    const provider = manager.providers.get("deepseek")!;
    expect(provider.isDisposed).toBe(false);
    expect([...root.children.values()].filter((child) => !child.isDisposed)).toEqual([provider]);
    root.dispose();
  });
});
