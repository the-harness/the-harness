export interface ExtHostBridge {
  callMain(method: string, ...args: unknown[]): Promise<unknown>;
  getRequestSignal?(): AbortSignal | undefined;
  releaseDroppedResponse?(command: string, listId: number): void;
  getWorkspaceRoots(): readonly string[];
  getExtensionPath?(): string | undefined;
  getExtensionId?(): string | undefined;
  getTerminalEnvironment?(
    env?: Record<string, string | null>,
    cwd?: string,
  ): Record<string, string | null>;
  activateExtension?(extensionId: string): Promise<unknown>;
  activateByEvent?(event: string): Promise<void>;
  readonly commandHandlers: Map<string, (...args: unknown[]) => unknown>;
}
