```ts
type McpServerStatus = "disconnected" | "connecting" | "connected" | "failed";

class McpService {
  readonly servers: ComputedRef<readonly McpServerConfig[]>;
  readonly tools: ComputedRef<readonly McpToolInfo[]>;
  readonly toolDefinitions: ComputedRef<readonly ToolDefinition[]>;
  registerServer(config: McpServerConfig): () => void;
  unregisterServer(id: string): void;
  getStatus(id: string): McpServerStatus;
  connect(serverId: string): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  refreshTools(serverId: string): Promise<readonly McpToolInfo[]>;
  listTools(serverId: string): Promise<readonly McpToolInfo[]>;
  callTool(
    serverId: string,
    rawName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

function useMcp(): void; // 在当前 EffectScope 中将 McpService 的工具响应式挂载到 ToolCallService
```
