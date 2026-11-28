import { ApiKeyAuthService, type AuthService } from "@harness/auth";
import {
  createDescriptor,
  inject,
  type Descriptor,
  type ServiceConstructor,
} from "@harness/di";
import { ProviderManager } from "@harness/model-provider";
import { getCurrentScope, onScopeDispose, type MaybeRefOrGetter } from "reactivity";
import { DEEPSEEK_DEFAULT_BASE_URL, type DeepSeekModelConfig } from "./catalog.ts";
import { DeepSeekFileService } from "./files.ts";
import { DeepSeekLlmProvider } from "./llm.ts";
import { DeepSeekAsrService, DeepSeekOcrService, DeepSeekTtsService } from "./tools.ts";
import { DeepSeekWebService } from "./web.ts";

export * from "./catalog.ts";
export * from "./files.ts";
export * from "./llm.ts";
export * from "./tools.ts";
export * from "./web.ts";

export interface DeepSeekProviderOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string | (() => Promise<string | undefined> | string | undefined);
  readonly auth?: ServiceConstructor<AuthService> | Descriptor<AuthService>;
  readonly models?: MaybeRefOrGetter<readonly DeepSeekModelConfig[]>;
  readonly catalogRefreshIntervalMs?: number;
  readonly preferFilesApi?: boolean;
  readonly defaultReasoningEffort?: "off" | "low" | "high" | "max";
  readonly fetch?: typeof fetch;
}

export function useDeepSeekProvider(options: DeepSeekProviderOptions = {}): void {
  if (getCurrentScope() === undefined) {
    throw new Error("useDeepSeekProvider() requires an active EffectScope");
  }
  const providerManager = inject(ProviderManager);
  const baseUrl = options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
  const authEntry =
    options.auth ??
    createDescriptor(ApiKeyAuthService, {
      apiKey:
        options.apiKey ??
        (() =>
          (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
            "DEEPSEEK_API_KEY"
          ]),
    });

  const providerScope = providerManager.create({ id: options.id ?? "deepseek" });
  onScopeDispose(() => providerScope.dispose());
  try {
    providerScope.provideAll([
      authEntry,
      createDescriptor(DeepSeekFileService, {
        baseUrl,
        fetch: options.fetch,
      }),
      createDescriptor(DeepSeekLlmProvider, {
        baseUrl,
        models: options.models,
        catalogRefreshIntervalMs: options.catalogRefreshIntervalMs,
        preferFilesApi: options.preferFilesApi,
        defaultReasoningEffort: options.defaultReasoningEffort,
        fetch: options.fetch,
      }),
      createDescriptor(DeepSeekWebService, {
        baseUrl,
        fetch: options.fetch,
      }),
      createDescriptor(DeepSeekTtsService, {
        baseUrl,
        fetch: options.fetch,
      }),
      createDescriptor(DeepSeekAsrService, {
        baseUrl,
        fetch: options.fetch,
      }),
      createDescriptor(DeepSeekOcrService, {
        baseUrl,
        fetch: options.fetch,
      }),
    ]);
  } catch (error) {
    providerScope.dispose();
    throw error;
  }
}
