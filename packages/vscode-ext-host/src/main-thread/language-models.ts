import { createDescriptor, type Scope } from "@harness/di";
import {
  AssistantMessage,
  DeveloperMessage,
  FunctionToolDeclaration,
  ImageBlock,
  ImageModality,
  LlmProvider,
  SystemMessage,
  TextBlock,
  TextModality,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
  type ContentBlock,
  type LlmChunk,
  type LlmModelInfo,
  type LlmRequest,
  type LlmResponse,
  type LlmService,
  type LlmStream,
  type Message,
} from "@harness/llm";
import type { ProviderManager } from "@harness/model-provider";
import { shallowRef, watch } from "reactivity";
import { CancellationError, LanguageModelError } from "@harness/vscode-types";
import {
  reviveModelError,
  serializeModelError,
  type MessageData,
  type ModelInformation,
  type ModelOptions,
  type ModelSelector,
  type ModelSnapshot,
  type PartData,
  type StreamItem,
} from "../vscode/language-model-wire.ts";

export interface LanguageModelBridgeHost {
  // The owning extension-host service supplies the actual worker command transport.
  executeCommand<T = unknown>(sessionId: string, command: string, ...args: unknown[]): Promise<T>;
}

type Registration = {
  session: string;
  vendor: string;
  providerId: string;
  scope: Scope;
  models: ReturnType<typeof shallowRef<readonly ModelInformation[]>>;
  controller: AbortController;
  stopped: boolean;
};
type Request = {
  session: string;
  provider?: Registration;
  controller: AbortController;
  iterator?: AsyncIterator<PartData>;
  cancel?: () => Promise<unknown>;
};

function toContent(parts: readonly PartData[]): ContentBlock[] {
  return parts.map((part) => {
    if (part.type === "text") return TextBlock.create({ text: part.value });
    if (part.type === "thinking")
      return ThinkingBlock.create({
        thinking: typeof part.value === "string" ? part.value : part.value.join(""),
        signature:
          typeof part.metadata?.signature === "string" ? part.metadata.signature : undefined,
      });
    if (part.type === "toolCall")
      return ToolCallBlock.create({
        id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input),
      });
    if (part.type === "data" && part.mimeType.startsWith("image/"))
      return ImageBlock.create({
        mimeType: part.mimeType,
        data: Buffer.from(part.data).toString("base64"),
      });
    throw new Error(`The core language model does not support '${part.type}' content here`);
  });
}
function toCoreMessages(messages: readonly MessageData[], model: LlmModelInfo): Message[] {
  const result: Message[] = [],
    tools = new Map<string, string>();
  for (const message of messages) {
    let pending: PartData[] = [];
    const flush = () => {
      if (!pending.length) return;
      const content = toContent(pending);
      result.push(
        message.role === 2
          ? AssistantMessage.create({ provider: model.provider, model: model.id, content })
          : message.role === 3
            ? SystemMessage.create({ content })
            : UserMessage.create({ content }),
      );
      pending = [];
    };
    for (const part of message.content) {
      if (part.type === "toolResult") {
        flush();
        result.push(
          ToolResultMessage.create({
            toolCallId: part.callId,
            toolName: tools.get(part.callId) ?? "",
            content: toContent(part.content),
            isError: part.isError,
          }),
        );
      } else {
        if (part.type === "toolCall") tools.set(part.callId, part.name);
        pending.push(part);
      }
    }
    flush();
  }
  return result;
}
function fromContent(content: readonly ContentBlock[]): PartData[] {
  return content.map((part) => {
    if (part instanceof TextBlock) return { type: "text", value: part.text };
    if (part instanceof ThinkingBlock)
      return {
        type: "thinking",
        value: part.thinking,
        metadata: part.signature ? { signature: part.signature } : undefined,
      };
    if (part instanceof ToolCallBlock)
      return {
        type: "toolCall",
        callId: part.id,
        name: part.name,
        input: JSON.parse(part.arguments),
      };
    if (part instanceof ImageBlock && part.data)
      return { type: "data", mimeType: part.mimeType, data: [...Buffer.from(part.data, "base64")] };
    throw new Error("The extension language model cannot represent this core content block");
  });
}
function fromCoreMessages(messages: readonly Message[]): MessageData[] {
  return messages.map((message) => {
    if (
      !(
        message instanceof UserMessage ||
        message instanceof AssistantMessage ||
        message instanceof ToolResultMessage ||
        message instanceof SystemMessage ||
        message instanceof DeveloperMessage
      )
    )
      throw new Error("Unsupported core language model message");
    const content = fromContent(message.content);
    if (message instanceof ToolResultMessage)
      return {
        role: 1,
        content: [
          { type: "toolResult", callId: message.toolCallId, content, isError: message.isError },
        ],
      };
    return {
      role: message instanceof AssistantMessage ? 2 : message instanceof UserMessage ? 1 : 3,
      content,
    };
  });
}

class ExtensionLanguageModelProvider extends LlmProvider {
  private readonly options: {
    models: () => readonly LlmModelInfo[];
    stream(request: LlmRequest): LlmStream;
  };
  constructor(options: ExtensionLanguageModelProvider["options"]) {
    super();
    this.options = options;
  }
  override get models() {
    return this.options.models();
  }
  override stream(request: LlmRequest) {
    return this.options.stream(request);
  }
}

export function createMainThreadLanguageModels(
  llm: LlmService,
  providers: ProviderManager,
  host: LanguageModelBridgeHost,
) {
  const registrations = new Map<string, Registration>();
  const sessions = new Set<string>();
  const requests = new Map<string, Request>();
  const key = (session: string, id: string) => JSON.stringify([session, id]);
  const notify = () => {
    for (const session of sessions)
      void host.executeCommand(session, "__lm.modelsChanged").catch(() => {});
  };
  const stopWatch = watch(() => llm.models, notify);
  const coreModels = (entry: Registration): LlmModelInfo[] =>
    entry.models.value.map((model) => ({
      id: model.id,
      name: model.name,
      provider: entry.providerId,
      contextWindow: model.maxInputTokens + model.maxOutputTokens,
      maxTokens: model.maxOutputTokens,
      reasoning: false,
      inputModalities: [
        TextModality.create({}),
        ...(model.capabilities.imageInput ? [ImageModality.create({})] : []),
      ],
      outputModalities: [TextModality.create({})],
    }));
  const findRegistration = (providerId: string) =>
    [...registrations.values()].find((entry) => entry.providerId === providerId);
  const getModel = (handle: string) => {
    const [provider, id] = JSON.parse(handle) as [string, string];
    const model = llm.models.find((model) => model.provider === provider && model.id === id);
    if (!model) throw LanguageModelError.NotFound(`Language model no longer exists: ${id}`);
    return model;
  };
  async function refresh(entry: Registration) {
    const models = await host.executeCommand<ModelInformation[]>(
      entry.session,
      "__lm.provideModels",
      entry.vendor,
    );
    if (registrations.get(key(entry.session, entry.vendor)) === entry) entry.models.value = models;
  }
  function selectChatModels(selector: ModelSelector = {}): ModelSnapshot[] {
    return llm.models
      .map((model) => {
        const entry = findRegistration(model.provider),
          info = entry?.models.value.find((value) => value.id === model.id);
        return {
          id: model.id,
          name: model.name,
          vendor: entry?.vendor ?? model.provider,
          family: info?.family ?? model.id,
          version: info?.version ?? "",
          maxInputTokens: info?.maxInputTokens ?? model.contextWindow - model.maxTokens,
          maxOutputTokens: model.maxTokens,
          capabilities: info?.capabilities ?? {
            imageInput: model.inputModalities.some((value) => value instanceof ImageModality),
            toolCalling: true,
          },
          handle: JSON.stringify([model.provider, model.id]),
        };
      })
      .filter((model) =>
        Object.entries(selector).every(
          ([name, value]) => value === undefined || model[name as keyof ModelSelector] === value,
        ),
      );
  }
  async function* extensionParts(
    entry: Registration,
    model: string,
    messages: MessageData[],
    options: ModelOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<PartData> {
    signal = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    const id = crypto.randomUUID();
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      if (entry.stopped || cancellation) return;
      cancellation = host.executeCommand(entry.session, "__lm.cancelProviderRequest", id);
      void cancellation.catch(console.error);
    };
    if (signal?.aborted) throw new CancellationError();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await host.executeCommand(
        entry.session,
        "__lm.startProviderRequest",
        entry.vendor,
        id,
        model,
        messages,
        options,
      );
      while (true) {
        if (signal?.aborted) throw new CancellationError();
        const item = await host.executeCommand<StreamItem>(
          entry.session,
          "__lm.nextProviderChunk",
          id,
        );
        if (signal?.aborted) throw new CancellationError();
        if (item.error) throw reviveModelError(item.error);
        if (item.done) return;
        yield item.value!;
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
      await cancellation;
    }
  }
  function extensionStream(entry: Registration, request: LlmRequest): LlmStream {
    const done = Promise.withResolvers<LlmResponse>();
    void done.promise.catch(() => {});
    const content: ContentBlock[] = [];
    const iterator = (async function* (): AsyncGenerator<LlmChunk> {
      let toolCalls = false,
        settled = false;
      try {
        const options: ModelOptions = {
          tools: request.tools
            ?.filter((tool) => tool instanceof FunctionToolDeclaration)
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
            })),
          modelOptions: {
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            reasoning: request.reasoning,
          },
          requestInitiator: "core",
        };
        const messages = fromCoreMessages(request.messages);
        if (request.systemPrompt) {
          messages.unshift({ role: 3, content: [{ type: "text", text: request.systemPrompt }] });
        }
        for await (const part of extensionParts(
          entry,
          request.model,
          messages,
          options,
          request.signal,
        )) {
          content.push(...toContent([part]));
          if (part.type === "text") yield { type: "text_delta", delta: part.value };
          else if (part.type === "thinking")
            yield {
              type: "thinking_delta",
              delta: typeof part.value === "string" ? part.value : part.value.join(""),
            };
          else if (part.type === "toolCall") {
            toolCalls = true;
            yield { type: "tool_call_start", id: part.callId, name: part.name };
            yield {
              type: "tool_call_end",
              id: part.callId,
              name: part.name,
              arguments: JSON.stringify(part.input),
            };
          } else throw new Error(`The core stream cannot represent '${part.type}' output`);
        }
        const response: LlmResponse = {
          message: AssistantMessage.create({
            provider: request.provider,
            model: request.model,
            content,
          }),
          stopReason: toolCalls ? "tool_calls" : "stop",
        };
        settled = true;
        done.resolve(response);
        yield { type: "finish", response };
      } catch (error) {
        settled = true;
        done.reject(error);
        throw error;
      } finally {
        if (!settled) done.reject(new CancellationError());
      }
    })();
    let consumed = false;
    return {
      [Symbol.asyncIterator]() {
        consumed = true;
        return iterator;
      },
      async result() {
        if (!consumed) {
          consumed = true;
          for await (const _chunk of iterator) {
          }
        }
        return done.promise;
      },
    };
  }
  async function* nativeParts(
    model: LlmModelInfo,
    messages: MessageData[],
    options: ModelOptions,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<PartData> {
    if (options.toolMode === 2)
      throw new Error("The core language model interface does not expose required-tool selection");
    for (const name of Object.keys(options.modelOptions ?? {}))
      if (!["temperature", "maxTokens", "reasoning"].includes(name))
        throw new Error(`Unsupported core language model option: ${name}`);
    const stream = llm.stream({
      provider: model.provider,
      model: model.id,
      messages: toCoreMessages(messages, model),
      sessionId,
      signal,
      tools: options.tools?.map((tool) =>
        FunctionToolDeclaration.create({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {},
        }),
      ),
      temperature: options.modelOptions?.temperature as number | undefined,
      maxTokens: options.modelOptions?.maxTokens as number | undefined,
      reasoning: options.modelOptions?.reasoning as boolean | string | undefined,
    });
    for await (const chunk of stream) {
      if (signal.aborted) throw new CancellationError();
      if (chunk.type === "text_delta") yield { type: "text", value: chunk.delta };
      else if (chunk.type === "thinking_delta") yield { type: "thinking", value: chunk.delta };
      else if (chunk.type === "tool_call_end")
        yield {
          type: "toolCall",
          callId: chunk.id,
          name: chunk.name,
          input: JSON.parse(chunk.arguments),
        };
      else if (chunk.type === "finish" && chunk.response.error)
        throw new Error(chunk.response.error.message);
    }
  }
  async function cancelRequest(session: string, id: string) {
    const request = requests.get(key(session, id));
    if (!request) return;
    requests.delete(key(session, id));
    request.controller.abort();
    try {
      await request.cancel?.();
    } finally {
      await request.iterator?.return?.();
    }
  }
  const handle = async (
    session: string,
    method: string,
    args: unknown[],
  ): Promise<{ handled: boolean; value?: unknown }> => {
    if (
      ![
        "lm.selectChatModels",
        "lm.registerChatProvider",
        "lm.refreshChatProvider",
        "lm.unregisterChatProvider",
        "lm.startRequest",
        "lm.nextChunk",
        "lm.cancelRequest",
        "lm.countTokens",
      ].includes(method)
    )
      return { handled: false };
    sessions.add(session);
    if (method === "lm.selectChatModels")
      return { handled: true, value: selectChatModels(args[0] as ModelSelector) };
    if (method === "lm.registerChatProvider") {
      const vendor = String(args[0]),
        registrationKey = key(session, vendor);
      if (registrations.has(registrationKey))
        throw new Error(`Language model vendor already registered: ${vendor}`);
      const providerId = `vscode:${session}:${vendor}`,
        scope = providers.create({ id: providerId });
      const entry: Registration = {
        session,
        vendor,
        providerId,
        scope,
        models: shallowRef([]),
        controller: new AbortController(),
        stopped: false,
      };
      registrations.set(registrationKey, entry);
      scope.provide(
        LlmProvider,
        createDescriptor(ExtensionLanguageModelProvider, {
          models: () => coreModels(entry),
          stream: (request) => extensionStream(entry, request),
        }),
      );
      try {
        await refresh(entry);
      } catch (error) {
        registrations.delete(registrationKey);
        entry.controller.abort();
        scope.dispose();
        throw error;
      }
      return { handled: true };
    }
    if (method === "lm.refreshChatProvider" || method === "lm.unregisterChatProvider") {
      const registrationKey = key(session, String(args[0])),
        entry = registrations.get(registrationKey);
      if (entry && method === "lm.refreshChatProvider") await refresh(entry);
      else if (entry) {
        registrations.delete(registrationKey);
        entry.controller.abort();
        entry.scope.dispose();
      }
      return { handled: true };
    }
    const id = String(args[0]),
      requestKey = key(session, id);
    if (method === "lm.cancelRequest") {
      await cancelRequest(session, id);
      return { handled: true };
    }
    if (method === "lm.startRequest") {
      try {
        const model = getModel(String(args[1])),
          controller = new AbortController(),
          entry = findRegistration(model.provider);
        const messages = args[2] as MessageData[],
          options = args[3] as ModelOptions;
        const iterator = (
          entry
            ? extensionParts(entry, model.id, messages, options, controller.signal)
            : nativeParts(model, messages, options, session, controller.signal)
        )[Symbol.asyncIterator]();
        requests.set(requestKey, { session, provider: entry, controller, iterator });
        return { handled: true, value: {} };
      } catch (error) {
        return { handled: true, value: { error: serializeModelError(error) } };
      }
    }
    if (method === "lm.nextChunk") {
      const request = requests.get(requestKey);
      if (!request?.iterator)
        return {
          handled: true,
          value: { done: true, error: serializeModelError(new CancellationError()) },
        };
      try {
        const item = await request.iterator.next();
        if (item.done) requests.delete(requestKey);
        return { handled: true, value: item };
      } catch (error) {
        requests.delete(requestKey);
        return { handled: true, value: { done: true, error: serializeModelError(error) } };
      }
    }
    const model = getModel(String(args[1])),
      entry = findRegistration(model.provider);
    if (!entry)
      throw new Error(`The core provider '${model.provider}' does not expose a tokenizer`);
    const controller = new AbortController();
    requests.set(requestKey, {
      session,
      provider: entry,
      controller,
      cancel: async () => {
        if (!entry.stopped)
          await host.executeCommand(entry.session, "__lm.cancelProviderRequest", id);
      },
    });
    try {
      return {
        handled: true,
        value: await host.executeCommand(
          entry.session,
          "__lm.countProviderTokens",
          entry.vendor,
          id,
          model.id,
          args[2],
        ),
      };
    } finally {
      requests.delete(requestKey);
    }
  };
  async function clearSession(session: string, hostStopped = false) {
    sessions.delete(session);
    const affected = [...requests].filter(
      ([, value]) => value.session === session || value.provider?.session === session,
    );
    if (hostStopped)
      for (const [, request] of affected)
        if (request.provider?.session === session) request.provider.stopped = true;
    for (const [registrationKey, entry] of registrations)
      if (entry.session === session) {
        entry.stopped = hostStopped;
        registrations.delete(registrationKey);
        entry.controller.abort();
        entry.scope.dispose();
      }
    const results = await Promise.allSettled(
      affected.map(([requestKey, request]) =>
        cancelRequest(request.session, (JSON.parse(requestKey) as string[])[1]!),
      ),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Failed to cancel language model requests");
  }
  return {
    handle,
    selectChatModels,
    clearSession,
    async dispose() {
      stopWatch();
      await Promise.all([...sessions].map((session) => clearSession(session)));
    },
  };
}
