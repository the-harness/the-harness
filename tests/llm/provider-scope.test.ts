import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHarnessModules, type HarnessModules } from "../helpers/harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type LlmModule = typeof import("../../packages/llm/src/index.ts");
type MockLlmModule = typeof import("../../packages/mock-llm/src/index.ts");
type ModelProviderModule = typeof import("../../packages/model-provider/src/index.ts");

let harness: HarnessModules;
let di: DiModule;
let llm: LlmModule;
let mockLlm: MockLlmModule;
let modelProvider: ModelProviderModule;

beforeAll(async () => {
  harness = await createHarnessModules();
  [di, llm, mockLlm, modelProvider] = await Promise.all([
    harness.load<DiModule>("/packages/di/src/index.ts"),
    harness.load<LlmModule>("/packages/llm/src/index.ts"),
    harness.load<MockLlmModule>("/packages/mock-llm/src/index.ts"),
    harness.load<ModelProviderModule>("/packages/model-provider/src/index.ts"),
  ]);
});

afterAll(async () => {
  await harness.close();
});

function createRoot() {
  const root = di.createRootScope();
  root.provideAll([modelProvider.ProviderManager, llm.LlmService]);
  return {
    root,
    manager: root.get(modelProvider.ProviderManager),
    service: root.get(llm.LlmService),
  };
}

function provider(id: string) {
  return di.createDescriptor(mockLlm.ScriptedMockLlmProvider, {
    provider: id,
    models: [{ id: `${id}-model`, name: id, provider: id }],
  });
}

describe("llm provider scopes", () => {
  it("lists models from registered provider scopes and streams through the resolved provider", async () => {
    const { root, manager, service } = createRoot();
    try {
      const alpha = manager.create({ id: "alpha" });
      alpha.provide(llm.LlmProvider, provider("alpha"));
      const beta = manager.create({ id: "beta" });
      beta.provide(llm.LlmProvider, provider("beta"));

      expect(service.models.map((model) => `${model.provider}/${model.id}`).sort()).toEqual([
        "alpha/alpha-model",
        "beta/beta-model",
      ]);

      const mock = alpha.get(llm.LlmProvider) as InstanceType<
        MockLlmModule["ScriptedMockLlmProvider"]
      >;
      mock.enqueue({ text: "alpha reply" });
      const response = await service
        .stream({
          provider: "alpha",
          model: "alpha-model",
          messages: [
            llm.UserMessage.create({ content: [llm.TextBlock.create({ text: "hello" })] }),
          ],
        })
        .result();
      expect(response.stopReason).toBe("stop");
      expect(llm.extractText(response.message.content)).toBe("alpha reply");
      expect(mock.requests).toHaveLength(1);
      expect(llm.extractText(mock.requests[0]!.request.messages[0]!.content)).toBe("hello");
    } finally {
      root.dispose();
    }
  });

  it("removes an unregistered provider from the model list and rejects its requests", () => {
    const { root, manager, service } = createRoot();
    try {
      const alpha = manager.create({ id: "alpha" });
      alpha.provide(llm.LlmProvider, provider("alpha"));
      expect(service.models).toHaveLength(1);

      alpha.dispose();
      expect(service.models).toEqual([]);
      expect(() =>
        service.stream({
          provider: "alpha",
          model: "alpha-model",
          messages: [],
        }),
      ).toThrow("unknown provider 'alpha'");
      expect(() => manager.create({ id: "alpha" })).not.toThrow();
    } finally {
      root.dispose();
    }
  });

  it("generates unique provider ids on the manager and rejects duplicates", () => {
    const { root, manager } = createRoot();
    try {
      const first = manager.create();
      const second = manager.create();
      expect(first.id).toMatch(/^provider-\d+$/);
      expect(second.id).not.toBe(first.id);
      expect(() => manager.create({ id: first.id })).toThrow(
        `provider '${first.id}' already exists`,
      );
      first.dispose();
      expect(manager.providers.has(first.id)).toBe(false);
      expect(manager.providers.has(second.id)).toBe(true);
    } finally {
      root.dispose();
    }
  });
});
