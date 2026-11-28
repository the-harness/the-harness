import { inject } from "@harness/di";
import { ProviderManager } from "@harness/model-provider";
import { computed, type ComputedRef } from "reactivity";
import {
  AssistantMessage,
  DeveloperMessage,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type Message,
} from "./message.ts";
import { projectSystemPrompt } from "./systemPrompt.ts";
import type {
  LlmModelInfo,
  LlmRequest,
  LlmStream,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResultItem,
} from "./types.ts";

export abstract class LlmProvider {
  abstract readonly models: readonly LlmModelInfo[];
  abstract stream(request: LlmRequest): LlmStream;
}

export class LlmService {
  protected readonly providerManager = inject(ProviderManager);
  protected readonly allModels: ComputedRef<readonly LlmModelInfo[]> = computed(() => {
    const out: LlmModelInfo[] = [];
    for (const [providerId] of this.providerManager.providers) {
      const scoped = this.getScopedProvider(providerId);
      if (scoped !== undefined) {
        out.push(...scoped.models);
      }
    }
    return out;
  });

  get models(): readonly LlmModelInfo[] {
    return this.allModels.value;
  }

  protected getScopedProvider(providerId: string): LlmProvider | undefined {
    const scope = this.providerManager.providers.get(providerId);
    if (scope === undefined || scope.isDisposed) {
      return undefined;
    }
    return scope.getOptional(LlmProvider);
  }

  canSend(messages: readonly Message[]): boolean {
    const unresolvedToolCalls = new Set<string>();
    let hasInput = false;

    for (const msg of messages) {
      if (msg instanceof AssistantMessage) {
        for (const block of msg.content) {
          if (block instanceof ToolCallBlock) {
            unresolvedToolCalls.add(block.id);
          }
        }
      } else if (msg instanceof ToolResultMessage) {
        unresolvedToolCalls.delete(msg.toolCallId);
        hasInput = true;
      } else if (msg instanceof UserMessage || msg instanceof DeveloperMessage) {
        hasInput = true;
      }
    }

    return hasInput && unresolvedToolCalls.size === 0;
  }

  stream(request: LlmRequest): LlmStream {
    const scoped = this.getScopedProvider(request.provider);
    if (scoped === undefined) {
      throw new Error(`unknown provider '${request.provider}'`);
    }
    const model = scoped.models.find((candidate) => candidate.id === request.model);
    return scoped.stream(projectSystemPrompt(request, model?.systemPromptUpdate === "in-history"));
  }

  async webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]> {
    const scoped = this.getScopedProvider(request.provider);
    if (scoped === undefined) {
      throw new Error(`unknown provider '${request.provider}'`);
    }
    const provider = scoped as LlmProvider & Partial<WebSearchProvider>;
    if (provider.webSearch === undefined) {
      throw new Error(`provider '${request.provider}' does not support web search`);
    }
    return provider.webSearch(request);
  }
}
