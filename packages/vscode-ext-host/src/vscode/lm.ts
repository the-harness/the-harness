import { createLanguageModelChatApi } from "./language-model-chat.ts";
import type { ExtHostBridge } from "./bridge.ts";
import { z } from "zod";
import {
  CancellationError,
  CancellationTokenSource,
  Disposable,
  LanguageModelToolResult,
  type CancellationToken,
  type Event,
  type McpHttpServerDefinition,
  type McpStdioServerDefinition,
} from "./types.ts";

export interface LanguageModelTool<T> {
  // Extensions implement tool invocations and optional confirmation preparation.
  invoke(
    options: { input: T; toolInvocationToken?: unknown },
    token: CancellationToken,
  ): ProviderResult<LanguageModelToolResult>;
  prepareInvocation?(
    options: { input: T },
    token: CancellationToken,
  ): ProviderResult<{ confirmationMessages?: unknown }>;
}

interface ToolContribution {
  name: string;
  modelDescription: string;
  inputSchema?: Record<string, unknown>;
  tags?: string[];
}

export type McpServerDefinition = McpStdioServerDefinition | McpHttpServerDefinition;
type ProviderResult<T> = T | null | undefined | PromiseLike<T | null | undefined>;

export interface McpServerDefinitionProvider<T extends McpServerDefinition = McpServerDefinition> {
  // Extensions implement this interface to provide and resolve MCP servers.
  readonly onDidChangeMcpServerDefinitions?: Event<void>;
  provideMcpServerDefinitions(token: CancellationToken): ProviderResult<readonly T[]>;
  resolveMcpServerDefinition?(server: T, token: CancellationToken): ProviderResult<T>;
}

function serializeDefinition(definition: McpServerDefinition) {
  if ("command" in definition) {
    return {
      label: definition.label,
      command: definition.command,
      args: definition.args,
      env: definition.env,
      cwd: definition.cwd?.toString(),
      version: definition.version,
    };
  }
  return {
    label: definition.label,
    uri: definition.uri.toString(true),
    headers: definition.headers,
    version: definition.version,
  };
}

export function createLmNamespace(bridge: ExtHostBridge) {
  const registeredTools = new Map<string, LanguageModelTool<unknown>>();
  const toolContributions = new Map<string, ToolContribution>();
  bridge.commandHandlers.set("__lm.syncTools", (raw) => {
    toolContributions.clear();
    for (const contribution of raw as ToolContribution[])
      toolContributions.set(contribution.name, contribution);
  });
  async function invokeTool(
    name: string,
    options: { input: unknown; toolInvocationToken?: unknown },
    token?: CancellationToken,
  ): Promise<LanguageModelToolResult> {
    const contribution = toolContributions.get(name);
    if (!contribution) throw new Error(`Unknown language model tool: ${name}`);
    await bridge.activateByEvent?.(`onLanguageModelTool:${name}`);
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Language model tool is not registered: ${name}`);
    if (contribution.inputSchema) z.fromJSONSchema(contribution.inputSchema).parse(options.input);
    const source = token ? undefined : new CancellationTokenSource();
    const requestToken = token ?? source!.token;
    try {
      if (requestToken.isCancellationRequested) throw new CancellationError();
      const preparation = await tool.prepareInvocation?.({ input: options.input }, requestToken);
      if (preparation?.confirmationMessages)
        throw new Error(`Tool '${name}' requires a confirmation UI`);
      const result = await tool.invoke(options, requestToken);
      if (requestToken.isCancellationRequested) throw new CancellationError();
      return result ?? new LanguageModelToolResult([]);
    } finally {
      source?.dispose();
    }
  }
  bridge.commandHandlers.set("__lm.invokeTool", async (name, options) => {
    const result = await invokeTool(String(name), options as Parameters<typeof invokeTool>[1]);
    const details = (
      result as LanguageModelToolResult & {
        toolResultDetails2?: { mime: string; value: Uint8Array };
      }
    ).toolResultDetails2;
    return {
      ...result,
      ...(details?.value instanceof Uint8Array
        ? { toolResultDetails2: { ...details, value: [...details.value] } }
        : {}),
    };
  });
  const providers = new Set<string>();
  const operations = new Map<string, Promise<unknown>>();
  function queue(id: string, operation: () => Promise<unknown>): Promise<unknown> {
    const next = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(id, next);
    void next
      .finally(() => {
        if (operations.get(id) === next) operations.delete(id);
      })
      .catch(() => {});
    return next;
  }
  return {
    ...createLanguageModelChatApi(bridge),
    get tools() {
      return [...toolContributions.values()].map((tool) =>
        Object.freeze({
          name: tool.name,
          description: tool.modelDescription,
          inputSchema: tool.inputSchema,
          tags: tool.tags ?? [],
        }),
      );
    },
    invokeTool,
    registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable {
      if (!toolContributions.has(name))
        throw new Error(`Language model tool '${name}' must be contributed in package.json`);
      if (registeredTools.has(name))
        throw new Error(`Language model tool already registered: ${name}`);
      registeredTools.set(name, tool as LanguageModelTool<unknown>);
      return new Disposable(() => {
        if (registeredTools.get(name) === tool) registeredTools.delete(name);
      });
    },
    registerMcpServerDefinitionProvider<T extends McpServerDefinition>(
      id: string,
      provider: McpServerDefinitionProvider<T>,
    ): Disposable {
      if (providers.has(id))
        throw new Error(`An MCP server definition provider with id '${id}' is already registered.`);
      providers.add(id);
      const provideCommand = `__mcp.provide.${id}`;
      const resolveCommand = `__mcp.resolve.${id}`;
      const requests = new Set<CancellationTokenSource>();
      let definitions: readonly T[] = [];
      let disposed = false;

      async function withToken<R>(
        operation: (token: CancellationToken) => ProviderResult<R>,
      ): Promise<R | undefined> {
        if (disposed) return undefined;
        const source = new CancellationTokenSource();
        requests.add(source);
        try {
          const result = await operation(source.token);
          return source.token.isCancellationRequested ? undefined : (result ?? undefined);
        } finally {
          requests.delete(source);
          source.dispose();
        }
      }

      bridge.commandHandlers.set(provideCommand, async () => {
        definitions =
          (await withToken((token) => provider.provideMcpServerDefinitions(token))) ?? [];
        return definitions.map(serializeDefinition);
      });
      bridge.commandHandlers.set(resolveCommand, async (index) => {
        const definition = definitions[index as number];
        if (!definition) throw new Error(`Unknown MCP server definition index: ${String(index)}`);
        const resolved = provider.resolveMcpServerDefinition
          ? await withToken((token) => provider.resolveMcpServerDefinition!(definition, token))
          : definition;
        return resolved && serializeDefinition(resolved);
      });

      const ready = queue(id, () =>
        bridge.callMain("lm.registerMcpProvider", id, {
          canResolve: !!provider.resolveMcpServerDefinition,
        }),
      );
      const changes = provider.onDidChangeMcpServerDefinitions?.(() => {
        void ready
          .then(() => {
            if (!disposed) return bridge.callMain("lm.didChangeMcpProvider", id);
          })
          .catch((error: unknown) => console.error(error));
      });
      const disposable = new Disposable(() => {
        disposed = true;
        providers.delete(id);
        changes?.dispose();
        for (const request of requests) {
          request.cancel();
          request.dispose();
        }
        requests.clear();
        definitions = [];
        bridge.commandHandlers.delete(provideCommand);
        bridge.commandHandlers.delete(resolveCommand);
        void queue(id, () => bridge.callMain("lm.unregisterMcpProvider", id)).catch(
          (error: unknown) => console.error(error),
        );
      });
      void ready.catch((error: unknown) => {
        disposable.dispose();
        console.error(error);
      });
      return disposable;
    },
  };
}
