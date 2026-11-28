import {
  clampThinkingLevel,
  getCurrentTools,
  getSupportedThinkingLevels,
  lazyStream,
  type Api,
  type AssistantMessageEvent,
  type Context as PiContext,
  type Model,
  type ModelsSimpleStreamOptions,
  type ModelThinkingLevel,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type CacheWarmingMode,
  type CacheWarmingStatus,
  type ExtensionRunner,
  type ModelRuntime,
  type SessionEntry,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inject } from "@harness/di";
import {
  FunctionToolDeclaration,
  ImageModality,
  ImageBlock,
  LlmService,
  TextBlock,
  TextModality,
  ToolResultMessage,
  UserMessage,
  type LlmChunk,
  type LlmModelInfo,
  type LlmProvider,
  type LlmRequest,
  type LlmStream,
} from "@harness/llm";
import { ProviderManager } from "@harness/model-provider";
import {
  fromPiAssistant,
  toPiMessages,
  type PiAssistant,
  type PiMessage,
  type PiUsageEntry,
} from "./extension-content.ts";
import { fromPiMessage } from "./extension-context.ts";
import { PiEvents } from "./pi-events.ts";
import { fromPiTool } from "./tool-declarations.ts";

interface CacheWarmRequest {
  readonly model: Model<Api>;
  readonly context: PiContext;
  readonly options: ModelsSimpleStreamOptions;
}

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
export const { isVirtualModel, getVirtualModelState, findLatestResponse } = (await import(
  new URL("core/virtual-models.js", sdk).href
)) as {
  isVirtualModel(model: Pick<Model<Api>, "api">): boolean;
  getVirtualModelState(branch: readonly SessionEntry[], provider: string, modelId: string): unknown;
  findLatestResponse(messages: readonly PiMessage[]): PiAssistant | undefined;
};

export const { CacheWarmer } = (await import(new URL("core/cache-warmer.js", sdk).href)) as {
  CacheWarmer: new (
    models: Pick<ModelRuntime, "streamSimple">,
    transcript: Pick<SessionManager, "appendUsage" | "getBranch">,
    getMode: () => CacheWarmingMode,
    decide: ExtensionRunner["emitCacheWarmingDecision"],
  ) => {
    readonly status: CacheWarmingStatus;
    onWarmed?: (entry: PiUsageEntry) => void;
    start(request: CacheWarmRequest, isCurrent: () => boolean): void;
    onAgentSettled(): void;
    onModeChanged(): void;
    cancel(): void;
  };
};

export class PiRuntimeApiKey {
  provider?: string;

  constructor(readonly key?: string) {}

  async apply(runtime: ModelRuntime): Promise<void> {
    if (this.key && this.provider) await runtime.setRuntimeApiKey(this.provider, this.key);
  }
}

export const DEFAULT_THINKING_LEVEL = "medium";

function toHarnessModel(model: Model<Api>): LlmModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    reasoning: model.reasoning ? getSupportedThinkingLevels(model) : false,
    inputModalities: [
      TextModality.create(),
      ...(model.input.includes("image") ? [ImageModality.create()] : []),
    ],
    outputModalities: [TextModality.create()],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toNativePiModel(model: LlmModelInfo): Model<Api> {
  const reasoning = model.reasoning;
  const levels: readonly ModelThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: "anthropic-messages",
    baseUrl: process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com/anthropic",
    input: model.inputModalities.some((modality) => modality instanceof ImageModality)
      ? ["text", "image"]
      : ["text"],
    reasoning: reasoning !== false,
    thinkingLevelMap: Array.isArray(reasoning)
      ? Object.fromEntries(
          levels.map((level) => [
            level,
            level === "off" || reasoning.includes(level) ? level : null,
          ]),
        )
      : undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function streamNative(
  llm: LlmService,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const thinkingLevel = clampThinkingLevel(model, options?.reasoning ?? "off");
  async function* stream(): AsyncGenerator<AssistantMessageEvent> {
    const output = llm.stream({
      provider: model.provider,
      model: model.id,
      messages: context.messages.flatMap((message, index) => fromPiMessage(message, index)),
      tools: getCurrentTools(context.messages).map(fromPiTool),
      reasoning: thinkingLevel === "off" ? false : thinkingLevel,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      sessionId: options?.sessionId,
      signal: options?.signal,
    });
    const events = new PiEvents(
      () => undefined,
      () => undefined,
    );
    const published: AssistantMessageEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        published.push({ type: "start", partial: event.message });
      }
      if (event.type === "message_update") published.push(event.assistantMessageEvent);
    });
    events.startTurn(model);
    for await (const chunk of output) {
      if (chunk.type === "finish") break;
      events.chunk(chunk);
      yield* published.splice(0);
    }
    const response = await events.finishMessage(await output.result());
    yield* published.splice(0);
    const [assistant] = toPiMessages([response.message]);
    if (assistant?.role !== "assistant")
      throw new Error("Native provider returned no assistant message");
    const message = { ...assistant, api: model.api, thinkingLevel };
    const { stopReason } = message;
    if (stopReason === "error" || stopReason === "aborted") {
      yield { type: "error", reason: stopReason, error: message };
    } else if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") {
      yield { type: "done", reason: stopReason, message };
    } else {
      throw new Error(`Unexpected native provider stop reason: ${stopReason}`);
    }
  }
  return lazyStream(model, async () => stream(), undefined, options?.signal);
}

function streamModel(
  runtime: ModelRuntime,
  runner: ExtensionRunner,
  model: Model<Api>,
  request: LlmRequest,
  observeRequest?: (request: CacheWarmRequest) => void,
): LlmStream {
  const requested =
    typeof request.reasoning === "string"
      ? (request.reasoning as ModelThinkingLevel)
      : request.reasoning === false
        ? "off"
        : DEFAULT_THINKING_LEVEL;
  const level = clampThinkingLevel(model, requested);
  const reasoning: SimpleStreamOptions["reasoning"] = level === "off" ? undefined : level;
  const context: PiContext = {
    systemPrompt: request.systemPrompt,
    messages: convertToLlm(toPiMessages(request.messages, { developerAsSystem: true })),
    tools: request.tools
      ?.filter((tool) => tool instanceof FunctionToolDeclaration)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Tool["parameters"],
        constrainedSampling: runner.getToolDefinition(tool.name)?.constrainedSampling,
      })),
  };
  const options: ModelsSimpleStreamOptions = {
    signal: request.signal,
    sessionId: request.sessionId,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    reasoning,
    transformHeaders: (headers) => runner.emitBeforeProviderHeaders(headers),
    onPayload: (payload) => runner.emitBeforeProviderRequest(payload),
    async onResponse({ status, headers }) {
      if (runner.hasHandlers("after_provider_response")) {
        await runner.emit({ type: "after_provider_response", status, headers });
      }
    },
    async onProviderStreamEvent(data, model) {
      if (runner.hasHandlers("provider_stream_event")) {
        await runner.emit({
          type: "provider_stream_event",
          data,
          provider: model.provider,
          api: model.api,
          model: model.id,
        });
      }
    },
  };
  const resultStream = runtime.streamSimple(model, context, options);
  observeRequest?.({ model, context, options });
  let result: ReturnType<LlmStream["result"]> | undefined;
  const collect = () =>
    (result ??= resultStream.result().then((message) => {
      const stop = message.stopReason;
      const stopReason =
        stop === "toolUse"
          ? "tool_calls"
          : stop === "length"
            ? "max_tokens"
            : stop === "pending" || stop === "deferred"
              ? "error"
              : stop;
      const error =
        stopReason === "error"
          ? { message: message.errorMessage ?? `Pi provider stopped with ${stop}` }
          : undefined;
      const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
      return {
        message: fromPiAssistant(
          isVirtualModel(model) ? message : { ...message, thinkingLevel: level },
        ),
        stopReason,
        usage: {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          totalTokens,
        },
        error,
      };
    }));
  return {
    result: collect,
    async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
      for await (const event of resultStream) {
        switch (event.type) {
          case "text_delta":
          case "thinking_delta":
            yield { type: event.type, delta: event.delta };
            break;
          case "toolcall_start": {
            const tool = event.partial.content[event.contentIndex];
            if (tool?.type === "toolCall")
              yield { type: "tool_call_start", id: tool.id, name: tool.name };
            break;
          }
          case "toolcall_delta": {
            const tool = event.partial.content[event.contentIndex];
            if (tool?.type === "toolCall")
              yield { type: "tool_call_delta", id: tool.id, delta: event.delta };
            break;
          }
          case "toolcall_end": {
            const { id, name, arguments: args } = event.toolCall;
            yield { type: "tool_call_end", id, name, arguments: JSON.stringify(args) };
            break;
          }
        }
      }
      yield { type: "finish", response: await collect() };
    },
  };
}

export class PiModelProviders {
  private readonly native = inject(ProviderManager);
  private readonly nativeBridges = new Map<string, Provider>();
  onRequest?: (request: CacheWarmRequest) => void;
  private state?: {
    readonly runtime: ModelRuntime;
    readonly runner: ExtensionRunner;
    readonly settings: SettingsManager;
    readonly available: () => readonly Model<Api>[];
  };

  constructor(private readonly nativeLlm: LlmService) {}

  registerNativeProviders(
    runtime: ModelRuntime,
    hasCredentials: (provider: string) => boolean,
  ): void {
    for (const [id] of this.native.providers) {
      const existing = this.nativeBridges.get(id);
      if (existing) {
        runtime.registerNativeProvider(existing);
        continue;
      }
      const upstream = runtime.getProvider(id);
      const apiKey = upstream?.auth.apiKey;
      const bridge: Provider = {
        id,
        name: upstream?.name ?? id,
        getModels: () =>
          this.nativeLlm.models.filter((model) => model.provider === id).map(toNativePiModel),
        auth: {
          apiKey: {
            name: apiKey?.name ?? "Harness API key",
            login: apiKey?.login?.bind(apiKey),
            resolve: async () => (hasCredentials(id) ? { auth: {}, source: "Harness" } : undefined),
          },
        },
        stream: (model, context, options) => streamNative(this.nativeLlm, model, context, options),
        streamSimple: (model, context, options) =>
          streamNative(this.nativeLlm, model, context, options),
      };
      this.nativeBridges.set(id, bridge);
      runtime.registerNativeProvider(bridge);
    }
  }

  restoreNativeProvider(runtime: ModelRuntime, id: string): void {
    const bridge = this.nativeBridges.get(id);
    if (bridge) runtime.registerNativeProvider(bridge);
  }

  overridesNative(providerId: string): boolean {
    const runtime = this.state?.runtime;
    const registered = runtime?.getRegisteredNativeProvider(providerId);
    return (
      runtime?.getRegisteredProviderConfig(providerId) !== undefined ||
      (registered !== undefined && registered !== this.nativeBridges.get(providerId))
    );
  }

  setRuntime(runtime: ModelRuntime, runner: ExtensionRunner, settings: SettingsManager): void {
    this.state = {
      runtime,
      runner,
      settings,
      available: runtime.getAvailableSnapshot.bind(runtime),
    };
  }

  get blockImages(): boolean {
    return this.state?.settings.getBlockImages() ?? false;
  }

  private modelsFor(providerId: string): readonly Model<Api>[] {
    if (!this.state) return [];
    const { runtime, available } = this.state;
    if (this.overridesNative(providerId)) return runtime.getModels(providerId);
    if (this.native.providers.has(providerId))
      return runtime.getModels(providerId).filter(isVirtualModel);
    return available().filter((model) => model.provider === providerId);
  }

  get models(): readonly LlmModelInfo[] {
    const ids = new Set([
      ...(this.state?.runtime.getRegisteredProviderIds() ?? []),
      ...(this.state?.available().map((model) => model.provider) ?? []),
    ]);
    return [...ids].flatMap((id) => this.modelsFor(id).map(toHarnessModel));
  }

  knownModels(): readonly Model<Api>[] {
    return this.state?.runtime.getModels() ?? [];
  }

  toPiModel(model: LlmModelInfo): Model<Api> {
    return (
      this.modelsFor(model.provider).find(({ id }) => id === model.id) ?? toNativePiModel(model)
    );
  }

  getProvider(providerId: string): LlmProvider | undefined {
    if (!this.state) return undefined;
    const { runtime, runner } = this.state;
    const observeRequest = this.onRequest;
    const models = this.modelsFor(providerId);
    if (models.length === 0) return undefined;
    return {
      models: models.map(toHarnessModel),
      stream(request) {
        const model = models.find(({ id }) => id === request.model);
        if (!model) throw new Error(`Model not found: ${providerId}/${request.model}`);
        return streamModel(runtime, runner, model, request, observeRequest);
      },
    };
  }
}

export class PiLlmService extends LlmService {
  private readonly pi = inject(PiModelProviders);

  constructor(private readonly routeTurnRequest: (request: LlmRequest) => LlmRequest) {
    super();
  }

  override get models(): readonly LlmModelInfo[] {
    const native = [...this.providerManager.providers.keys()].flatMap((id) =>
      this.pi.overridesNative(id) ? [] : (super.getScopedProvider(id)?.models ?? []),
    );
    return [...native, ...this.pi.models];
  }

  protected override getScopedProvider(providerId: string): LlmProvider | undefined {
    const pi = this.pi.getProvider(providerId);
    const native = super.getScopedProvider(providerId);
    if (!pi || !native || this.pi.overridesNative(providerId)) return pi ?? native;
    return {
      models: [...native.models, ...pi.models],
      stream(request) {
        return pi.models.some(({ id }) => id === request.model)
          ? pi.stream(request)
          : native.stream(request);
      },
    };
  }

  override stream(request: LlmRequest): LlmStream {
    request = this.routeTurnRequest(request);
    if (!this.pi.blockImages) return super.stream(request);
    const omitted = "Image reading is disabled.";
    const messages = request.messages.map((message) => {
      if (
        !(message instanceof UserMessage || message instanceof ToolResultMessage) ||
        !message.content.some((block) => block instanceof ImageBlock)
      )
        return message;
      const content = message.content
        .map((block) => (block instanceof ImageBlock ? TextBlock.create({ text: omitted }) : block))
        .filter((block, index, blocks) => {
          const previous = blocks[index - 1];
          return !(
            block instanceof TextBlock &&
            block.text === omitted &&
            previous instanceof TextBlock &&
            previous.text === omitted
          );
        });
      return message instanceof ToolResultMessage
        ? ToolResultMessage.create({ ...message, content })
        : UserMessage.create({ ...message, content });
    });
    return super.stream({ ...request, messages });
  }
}
