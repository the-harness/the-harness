import type { ExtHostBridge } from "./bridge.ts";
import {
  CancellationError,
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  LanguageModelTextPart,
  type CancellationToken,
  type Event,
} from "@harness/vscode-types";
import {
  reviveMessage,
  reviveModelError,
  revivePart,
  serializeMessage,
  serializeModelError,
  serializePart,
  type MessageData,
  type ModelInformation,
  type ModelOptions,
  type ModelSelector,
  type ModelSnapshot,
  type PartData,
  type StreamItem,
} from "./language-model-wire.ts";

export interface LanguageModelChatProvider<T extends ModelInformation = ModelInformation> {
  // Extensions supply model metadata, streamed response parts and their actual tokenizer.
  onDidChangeLanguageModelChatInformation?: Event<void>;
  provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: CancellationToken,
  ): T[] | undefined | null | PromiseLike<T[] | undefined | null>;
  provideLanguageModelChatResponse(
    model: T,
    messages: readonly ReturnType<typeof reviveMessage>[],
    options: ModelOptions,
    progress: { report(part: unknown): void },
    token: CancellationToken,
  ): PromiseLike<void>;
  provideTokenCount(
    model: T,
    text: string | ReturnType<typeof reviveMessage>,
    token: CancellationToken,
  ): PromiseLike<number>;
}

export function reviveLanguageModelChat(bridge: ExtHostBridge, snapshot: ModelSnapshot) {
  const { handle, ...metadata } = snapshot;
  return Object.freeze({
    ...metadata,
    async sendRequest(
      messages: Parameters<typeof serializeMessage>[0][],
      options: ModelOptions = {},
      token?: CancellationToken,
    ) {
      if (token?.isCancellationRequested) throw new CancellationError();
      const id = crypto.randomUUID();
      let complete = false;
      const cancel = () => {
        void bridge.callMain("lm.cancelRequest", id).catch(console.error);
      };
      const subscription = token?.onCancellationRequested(cancel);
      try {
        const result = (await bridge.callMain(
          "lm.startRequest",
          id,
          handle,
          messages.map(serializeMessage),
          options,
        )) as { error?: StreamItem["error"] };
        if (result?.error) throw reviveModelError(result.error);
        if (token?.isCancellationRequested) {
          cancel();
          throw new CancellationError();
        }
      } catch (error) {
        subscription?.dispose();
        throw error;
      }
      const parts: unknown[] = [];
      let failure: Error | undefined;
      let pulling: Promise<void> | undefined;
      const next = () =>
        (pulling ??= (async () => {
          const item = (await bridge.callMain("lm.nextChunk", id)) as StreamItem;
          if (item.error) {
            failure = reviveModelError(item.error);
            complete = true;
          } else if (item.done) complete = true;
          else parts.push(revivePart(item.value!));
        })()
          .catch((error) => {
            failure = error instanceof Error ? error : new Error(String(error));
            complete = true;
          })
          .finally(() => {
            pulling = undefined;
            if (complete) subscription?.dispose();
          }));
      const stream: AsyncIterable<unknown> = {
        async *[Symbol.asyncIterator]() {
          let index = 0;
          try {
            while (true) {
              if (token?.isCancellationRequested) throw new CancellationError();
              if (index < parts.length) {
                yield parts[index++];
                continue;
              }
              if (failure) throw failure;
              if (complete) return;
              await next();
            }
          } finally {
            if (!complete) {
              subscription?.dispose();
              cancel();
            }
          }
        },
      };
      const text: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for await (const part of stream)
            if (part instanceof LanguageModelTextPart) yield part.value;
        },
      };
      return { stream, text };
    },
    async countTokens(
      text: string | Parameters<typeof serializeMessage>[0],
      token?: CancellationToken,
    ): Promise<number> {
      if (token?.isCancellationRequested) throw new CancellationError();
      const id = crypto.randomUUID(),
        subscription = token?.onCancellationRequested(() => {
          void bridge.callMain("lm.cancelRequest", id).catch(console.error);
        });
      try {
        const count = (await bridge.callMain(
          "lm.countTokens",
          id,
          handle,
          typeof text === "string" ? text : serializeMessage(text),
        )) as number;
        if (token?.isCancellationRequested) throw new CancellationError();
        return count;
      } finally {
        subscription?.dispose();
      }
    },
  });
}

export function createLanguageModelChatApi(bridge: ExtHostBridge) {
  const changed = new EventEmitter<void>();
  let contributedVendors: string[] = [];
  bridge.commandHandlers.set("__lm.syncProviders", (raw) => {
    contributedVendors = raw as string[];
  });
  const providers = new Map<
    string,
    {
      provider: LanguageModelChatProvider;
      models: Map<string, ModelInformation>;
      requests: Set<string>;
      dispose: Disposable;
    }
  >();
  const requests = new Map<
    string,
    {
      source: CancellationTokenSource;
      queue: PartData[];
      wake?: () => void;
      done: boolean;
      error?: StreamItem["error"];
      vendor: string;
    }
  >();
  const registrations = new Set<Promise<unknown>>();
  const finishRequest = (id: string, cancel = true) => {
    const request = requests.get(id);
    if (!request) return;
    if (cancel) request.source.cancel();
    request.source.dispose();
    request.done = true;
    request.wake?.();
    providers.get(request.vendor)?.requests.delete(id);
    requests.delete(id);
  };
  bridge.commandHandlers.set("__lm.modelsChanged", () => changed.fire());
  bridge.commandHandlers.set("__lm.provideModels", async (rawVendor) => {
    const entry = providers.get(String(rawVendor));
    if (!entry) throw new Error(`Unknown language model vendor: ${String(rawVendor)}`);
    const source = new CancellationTokenSource();
    try {
      const models =
        (await entry.provider.provideLanguageModelChatInformation(
          { silent: true },
          source.token,
        )) ?? [];
      entry.models = new Map(models.map((model) => [model.id, model]));
      return models.map(
        ({ id, name, family, version, maxInputTokens, maxOutputTokens, capabilities }) => ({
          id,
          name,
          family,
          version,
          maxInputTokens,
          maxOutputTokens,
          capabilities,
        }),
      );
    } finally {
      source.dispose();
    }
  });
  bridge.commandHandlers.set(
    "__lm.startProviderRequest",
    (rawVendor, rawId, rawModel, rawMessages, rawOptions) => {
      const vendor = String(rawVendor),
        id = String(rawId),
        entry = providers.get(vendor),
        model = entry?.models.get(String(rawModel));
      if (!entry || !model)
        throw new Error(`Unknown language model: ${vendor}/${String(rawModel)}`);
      const request = {
        source: new CancellationTokenSource(),
        queue: [] as PartData[],
        done: false,
        vendor,
      } as NonNullable<ReturnType<typeof requests.get>>;
      requests.set(id, request);
      entry.requests.add(id);
      void Promise.resolve()
        .then(() =>
          entry.provider.provideLanguageModelChatResponse(
            model,
            (rawMessages as MessageData[]).map(reviveMessage),
            { toolMode: 1, ...(rawOptions as ModelOptions) },
            {
              report(part) {
                if (!request.source.token.isCancellationRequested) {
                  request.queue.push(serializePart(part));
                  request.wake?.();
                }
              },
            },
            request.source.token,
          ),
        )
        .then(
          () => {
            request.done = true;
            request.wake?.();
          },
          (error) => {
            request.error = serializeModelError(error);
            request.done = true;
            request.wake?.();
          },
        );
    },
  );
  bridge.commandHandlers.set("__lm.nextProviderChunk", async (rawId) => {
    const id = String(rawId),
      request = requests.get(id);
    if (!request) return { done: true, error: serializeModelError(new CancellationError()) };
    while (!request.queue.length && !request.done)
      await new Promise<void>((resolve) => {
        request.wake = resolve;
      });
    if (request.queue.length) return { done: false, value: request.queue.shift() };
    const result: StreamItem = { done: true, error: request.error };
    finishRequest(id, false);
    return result;
  });
  bridge.commandHandlers.set("__lm.cancelProviderRequest", (rawId) => finishRequest(String(rawId)));
  bridge.commandHandlers.set(
    "__lm.countProviderTokens",
    async (rawVendor, rawId, rawModel, rawText) => {
      const vendor = String(rawVendor),
        id = String(rawId),
        entry = providers.get(vendor),
        model = entry?.models.get(String(rawModel));
      if (!entry || !model)
        throw new Error(`Unknown language model: ${vendor}/${String(rawModel)}`);
      const request = {
        source: new CancellationTokenSource(),
        queue: [],
        done: false,
        vendor,
      } as NonNullable<ReturnType<typeof requests.get>>;
      requests.set(id, request);
      entry.requests.add(id);
      try {
        return await entry.provider.provideTokenCount(
          model,
          typeof rawText === "string" ? rawText : reviveMessage(rawText as MessageData),
          request.source.token,
        );
      } finally {
        finishRequest(id, false);
      }
    },
  );
  return {
    onDidChangeChatModels: changed.event,
    async selectChatModels(selector: ModelSelector = {}) {
      const vendors = selector.vendor ? [selector.vendor] : contributedVendors;
      for (const vendor of vendors)
        if (!providers.has(vendor))
          await bridge.activateByEvent?.(`onLanguageModelChatProvider:${vendor}`);
      await Promise.all(registrations);
      const models = (await bridge.callMain("lm.selectChatModels", selector)) as ModelSnapshot[];
      return models.map((model) => reviveLanguageModelChat(bridge, model));
    },
    registerLanguageModelChatProvider(
      vendor: string,
      provider: LanguageModelChatProvider,
    ): Disposable {
      if (providers.has(vendor))
        throw new Error(`Language model provider already registered: ${vendor}`);
      let disposed = false;
      const changes = provider.onDidChangeLanguageModelChatInformation?.(() => {
        void ready
          .then(() => {
            if (!disposed) return bridge.callMain("lm.refreshChatProvider", vendor);
          })
          .catch(console.error);
      });
      const dispose = new Disposable(() => {
        if (disposed) return;
        disposed = true;
        changes?.dispose();
        for (const id of providers.get(vendor)?.requests ?? []) finishRequest(id);
        providers.delete(vendor);
        void ready
          .then(() => bridge.callMain("lm.unregisterChatProvider", vendor))
          .catch(console.error);
      });
      providers.set(vendor, { provider, models: new Map(), requests: new Set(), dispose });
      const ready = bridge.callMain("lm.registerChatProvider", vendor);
      registrations.add(ready);
      void ready
        .catch((error) => {
          dispose.dispose();
          console.error(error);
        })
        .finally(() => registrations.delete(ready));
      return dispose;
    },
  };
}
