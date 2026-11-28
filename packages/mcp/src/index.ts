import { createHash } from "node:crypto";
import { inject } from "@harness/di";
import { ToolCallService, functionTool, type ToolDefinition } from "@harness/tool-call";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  computed,
  effectScope,
  onScopeDispose,
  reactive,
  watch,
  type ComputedRef,
} from "reactivity";
import { z } from "zod";

export type McpServerConfig =
  | {
      readonly id: string;
      readonly label: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
      readonly startupTimeoutMs?: number;
      readonly toolTimeoutMs?: number;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly startupTimeoutMs?: number;
      readonly toolTimeoutMs?: number;
    };

export type McpServerStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface McpToolInfo {
  readonly serverId: string;
  readonly rawName: string;
  readonly qualifiedName: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export function qualifyMcpToolName(serverId: string, rawName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `mcp__${safeServer}__${safeTool}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(`${serverId}\0${rawName}`).digest("hex").slice(0, 8);
  return `${full.slice(0, 55)}_${hash}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class McpService {
  private readonly configs = reactive(new Map<string, McpServerConfig>());
  private readonly statuses = reactive(new Map<string, McpServerStatus>());
  private readonly toolsCache = reactive(new Map<string, readonly McpToolInfo[]>());
  private readonly clients = new Map<string, Client>();
  private readonly toolRefreshes = new WeakMap<
    Client,
    { running: Promise<readonly McpToolInfo[]>; queued?: Promise<readonly McpToolInfo[]> }
  >();

  readonly servers: ComputedRef<readonly McpServerConfig[]> = computed(() =>
    Array.from(this.configs.values()),
  );

  readonly tools: ComputedRef<readonly McpToolInfo[]> = computed(() =>
    Array.from(this.toolsCache.values()).flat(),
  );

  readonly toolDefinitions: ComputedRef<readonly ToolDefinition[]> = computed(() =>
    this.tools.value.map((tool) =>
      functionTool({
        name: tool.qualifiedName,
        description: tool.description ?? `MCP tool ${tool.rawName} (${tool.serverId})`,
        parameters: z.record(z.string(), z.unknown()),
        execute: async (args, ctx) => {
          const res = await this.callTool(tool.serverId, tool.rawName, args, ctx.signal);
          const output = typeof res === "string" ? res : JSON.stringify(res);
          if (res !== null && typeof res === "object" && "isError" in res && res.isError === true) {
            throw new Error(output);
          }
          return output;
        },
      }),
    ),
  );

  constructor() {
    watch(
      () => this.servers.value.map((s) => s.id),
      (ids, prevIds = []) => {
        const nextSet = new Set(ids);
        const prevSet = new Set(prevIds);
        for (const id of ids) {
          if (!prevSet.has(id)) {
            void this.connect(id).catch(() => {});
          }
        }
        for (const id of prevIds) {
          if (!nextSet.has(id)) {
            void this.disconnect(id);
          }
        }
      },
      { immediate: true },
    );

    onScopeDispose(() => {
      void this.dispose();
    });
  }

  registerServer(config: McpServerConfig): () => void {
    this.configs.set(config.id, config);
    this.statuses.set(config.id, "disconnected");
    return () => this.unregisterServer(config.id);
  }

  unregisterServer(id: string): void {
    this.configs.delete(id);
    this.statuses.delete(id);
    void this.disconnect(id);
  }

  getStatus(id: string): McpServerStatus {
    return this.statuses.get(id) ?? "disconnected";
  }

  async connect(serverId: string): Promise<void> {
    if (this.clients.has(serverId)) return;
    const config = this.configs.get(serverId);
    if (!config) throw new Error(`MCP server not registered: ${serverId}`);

    this.statuses.set(serverId, "connecting");
    const startupTimeout = config.startupTimeoutMs ?? 30_000;

    try {
      const client = await this.createConnectedClient(config, startupTimeout);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.refreshTools(serverId);
      });
      this.clients.set(serverId, client);
      this.statuses.set(serverId, "connected");
      await this.refreshTools(serverId);
    } catch (error) {
      this.statuses.set(serverId, "failed");
      throw error;
    }
  }

  private async createConnectedClient(
    config: McpServerConfig,
    startupTimeoutMs: number,
  ): Promise<Client> {
    if (config.transport === "stdio") {
      const client = new Client({ name: "harness", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        env: config.env,
      });
      await withTimeout(client.connect(transport), startupTimeoutMs, `MCP connect(${config.id})`);
      return client;
    }

    const url = new URL(config.url);
    const httpClient = new Client({ name: "harness", version: "0.1.0" });
    try {
      const httpTransport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
      await withTimeout(
        httpClient.connect(httpTransport),
        startupTimeoutMs,
        `MCP connect(${config.id})`,
      );
      return httpClient;
    } catch {
      const sseClient = new Client({ name: "harness", version: "0.1.0" });
      const sseTransport = new SSEClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
      await withTimeout(
        sseClient.connect(sseTransport),
        startupTimeoutMs,
        `MCP SSE connect(${config.id})`,
      );
      return sseClient;
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.toolsCache.delete(serverId);
    if (this.configs.has(serverId)) {
      this.statuses.set(serverId, "disconnected");
    }
    await client?.close().catch(() => {});
  }

  async refreshTools(serverId: string): Promise<readonly McpToolInfo[]> {
    const client = this.clients.get(serverId);
    if (!client) return [];
    const current = this.toolRefreshes.get(client);
    if (current) {
      const refresh = () =>
        this.clients.get(serverId) === client ? this.refreshTools(serverId) : [];
      current.queued ??= current.running.then(refresh, refresh);
      return current.queued;
    }

    const running = this.refreshClientTools(serverId, client).finally(() => {
      this.toolRefreshes.delete(client);
    });
    this.toolRefreshes.set(client, { running });
    return running;
  }

  private async refreshClientTools(
    serverId: string,
    client: Client,
  ): Promise<readonly McpToolInfo[]> {
    const res = await client.listTools();
    if (this.clients.get(serverId) !== client) return [];
    const list: McpToolInfo[] = (res.tools ?? []).map((t) => ({
      serverId,
      rawName: t.name,
      qualifiedName: qualifyMcpToolName(serverId, t.name),
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
    this.toolsCache.set(serverId, list);
    return list;
  }

  async listTools(serverId: string): Promise<readonly McpToolInfo[]> {
    if (!this.clients.has(serverId)) {
      await this.connect(serverId);
    }
    return this.toolsCache.get(serverId) ?? [];
  }

  async callTool(
    serverId: string,
    rawName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.clients.has(serverId)) {
      await this.connect(serverId);
    }
    const client = this.clients.get(serverId)!;
    const timeoutMs = this.configs.get(serverId)?.toolTimeoutMs ?? 60_000;
    return await client.callTool({ name: rawName, arguments: args ?? {} }, undefined, {
      signal,
      timeout: timeoutMs,
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.clients.keys()).map((id) => this.disconnect(id)));
    this.configs.clear();
    this.statuses.clear();
    this.toolsCache.clear();
  }
}

export function useMcp(): void {
  const mcp = inject(McpService);
  const toolCall = inject(ToolCallService);

  watch(
    () => mcp.toolDefinitions.value,
    (tools, _prev, onCleanup) => {
      const scope = effectScope();
      scope.run(() => {
        for (const tool of tools) {
          toolCall.useTool(tool);
        }
      });
      onCleanup(() => scope.stop());
    },
    { immediate: true },
  );
}
