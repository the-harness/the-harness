import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inject } from "@harness/di";
import { HookSlot } from "@harness/hooks";
import { McpService, type McpServerConfig } from "@harness/mcp";
import { SyncedValueHost } from "@harness/state-sync";
import { onScopeDispose, shallowRef } from "reactivity";
import { readExtensionContributions } from "./contributions.ts";
import type { IpcMessage, RpcCancel, RpcRelease, RpcRequest, RpcResponse } from "./ipc.ts";
import { registerEnvironmentStorage } from "./node/environment-storage.ts";
import { createMainThreadDataChannels } from "./main-thread/env-data-channels.ts";
import { scanExtensionsDir, type ExtensionManifest } from "./manifest.ts";
import { installVsix } from "./vsix.ts";
import { decodeExtHostError, encodeExtHostError } from "./wire-error.ts";

interface SessionHost {
  readonly process: ChildProcess;
  readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  stopping?: Promise<void>;
}

export type MainThreadCallHandler = (
  sessionId: string,
  method: string,
  args: unknown[],
  requestId: string,
) => Promise<unknown>;

export type MainThreadCallRouter = (
  sessionId: string,
  method: string,
  args: unknown[],
) => Promise<{ handled: boolean; value?: unknown }>;

interface ExtensionMcpServerDefinition {
  readonly label?: string;
  readonly command?: string;
  readonly args?: readonly unknown[];
  readonly env?: Record<string, string | number | null>;
  readonly uri?: string;
  readonly headers?: Record<string, string>;
}

function toMcpServerConfig(serverId: string, raw: unknown): McpServerConfig | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const definition = raw as ExtensionMcpServerDefinition;
  const label = definition.label ?? serverId;
  if (typeof definition.command === "string" && definition.command.length > 0) {
    const args = Array.isArray(definition.args)
      ? definition.args.filter((item): item is string => typeof item === "string")
      : undefined;
    const env = definition.env
      ? Object.fromEntries(
          Object.entries(definition.env)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)]),
        )
      : undefined;
    return { id: serverId, label, transport: "stdio", command: definition.command, args, env };
  }
  if (typeof definition.uri === "string" && definition.uri.length > 0) {
    return {
      id: serverId,
      label,
      transport: "http",
      url: definition.uri,
      headers: definition.headers,
    };
  }
  return undefined;
}

// Extensible lifecycle hooks for the extension host.
export interface ExtensionHostHooks {
  readonly sessionStopped: HookSlot<string>;
}

export class ExtensionHostService {
  readonly hooks: ExtensionHostHooks = {
    sessionStopped: new HookSlot<string>(),
  };
  readonly dataChannels = createMainThreadDataChannels(this);
  private readonly workerPath: string;
  private readonly extensionsDir: string | undefined;
  private initialization: Promise<void> | undefined;
  private readonly sessions = new Map<string, SessionHost>();
  private readonly manifests = new Map<string, ExtensionManifest>();
  private readonly contributionRevision = shallowRef<string>(randomUUID());
  readonly contributionsVersion = new SyncedValueHost(this.contributionRevision);
  private readonly mainThreadHandlers = new Set<MainThreadCallHandler>();
  private readonly mainThreadRouters = new Set<MainThreadCallRouter>();
  private readonly pendingMainCalls = new Map<
    string,
    { host: SessionHost; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private mainCallCounter = 0;
  private readonly mcp = inject(McpService);
  private readonly mcpProviders = new Map<string, readonly (() => void)[]>();

  constructor(options: { readonly workerPath?: string; readonly extensionsDir?: string } = {}) {
    registerEnvironmentStorage(this);
    this.workerPath = options.workerPath ?? fileURLToPath(new URL("./worker.ts", import.meta.url));
    this.extensionsDir =
      options.extensionsDir ??
      process.env["HARNESS_VSCODE_EXTENSIONS_DIR"] ??
      process.env["HARNESS_VSCODE_BUILTINS_DIR"];
    onScopeDispose(() => {
      for (const sessionId of [...this.sessions.keys()]) {
        void this.stopSession(sessionId);
      }
      for (const { reject } of this.pendingMainCalls.values()) {
        reject(new Error("extension host disposed"));
      }
      this.pendingMainCalls.clear();
    });
  }

  async installVsix(vsixPath: string, extensionsDir: string): Promise<ExtensionManifest> {
    await this.ensureInitialized();
    const manifest = await installVsix(vsixPath, extensionsDir);
    this.manifests.set(manifest.id, manifest);
    await this.syncExtensions();
    return manifest;
  }

  async scanExtensions(extensionsDir: string): Promise<ExtensionManifest[]> {
    await this.ensureInitialized();
    const list = await scanExtensionsDir(extensionsDir);
    for (const item of list) {
      this.manifests.set(item.id, item);
    }
    await this.syncExtensions();
    return list;
  }

  async getContributions() {
    await this.ensureInitialized();
    return readExtensionContributions([...this.manifests.values()]);
  }

  async removeContentExtension(extensionId: string): Promise<boolean> {
    await this.ensureInitialized();
    const manifest = this.manifests.get(extensionId);
    if (!manifest || manifest.main || manifest.packageJSON?.browser) return false;
    return this.removeExtension(extensionId);
  }

  async removeExtension(extensionId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.manifests.has(extensionId)) return false;
    const key = extensionId.toLowerCase();
    for (const manifest of this.manifests.values()) {
      if (
        manifest.id !== extensionId &&
        manifest.extensionDependencies?.some((dependency) => dependency.toLowerCase() === key)
      )
        return false;
    }
    this.manifests.delete(extensionId);
    await this.syncExtensions();
    return true;
  }

  private ensureInitialized(): Promise<void> {
    return (this.initialization ??= this.loadConfiguredExtensions());
  }

  private async loadConfiguredExtensions(): Promise<void> {
    if (!this.extensionsDir) return;
    for (const manifest of await scanExtensionsDir(this.extensionsDir)) {
      this.manifests.set(manifest.id, manifest);
    }
  }

  onMainThreadCall(handler: MainThreadCallHandler): () => void {
    this.mainThreadHandlers.add(handler);
    return () => this.mainThreadHandlers.delete(handler);
  }

  registerMainThreadRouter(router: MainThreadCallRouter): () => void {
    this.mainThreadRouters.add(router);
    return () => {
      this.mainThreadRouters.delete(router);
    };
  }

  async startSession(
    sessionId: string,
    workspaceRoots: readonly string[],
    initialState: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureInitialized();
    signal?.throwIfAborted();
    if (this.sessions.has(sessionId)) {
      await this.callWorker(sessionId, "init", [
        [...workspaceRoots],
        initialState,
        [...this.manifests.values()],
      ]);
      return;
    }

    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      execArgv: [],
    });

    const host: SessionHost = {
      process: child,
      pending: new Map(),
      nextId: 1,
    };
    this.sessions.set(sessionId, host);

    child.on("message", async (msg: IpcMessage) => {
      if (msg.type === "response") {
        const entry = host.pending.get(msg.id);
        if (!entry) {
          if (msg.release && child.connected)
            child.send({ type: "release", ...msg.release } satisfies RpcRelease, () => {});
          return;
        }
        host.pending.delete(msg.id);
        if (msg.error !== undefined) entry.reject(decodeExtHostError({ ...msg, error: msg.error }));
        else entry.resolve(msg.result);
        return;
      }

      if (msg.type === "request") {
        const requestId = `mc-${++this.mainCallCounter}`;
        try {
          const replyPromise = new Promise((resolve, reject) => {
            this.pendingMainCalls.set(requestId, { host, resolve, reject });
          });
          void replyPromise.catch(() => undefined);
          let handled = false;
          for (const router of this.mainThreadRouters) {
            const result = await router(sessionId, msg.method, msg.args);
            if (!result.handled) continue;
            this.resolveMainCall(requestId, result.value);
            handled = true;
            break;
          }
          if (!handled) {
            for (const handler of this.mainThreadHandlers) {
              await handler(sessionId, msg.method, msg.args, requestId);
            }
          }
          const result = await replyPromise;
          if (child.connected)
            child.send({ type: "response", id: msg.id, result } satisfies RpcResponse);
        } catch (error) {
          if (child.connected)
            child.send({
              type: "response",
              id: msg.id,
              ...encodeExtHostError(error),
            } satisfies RpcResponse);
        } finally {
          this.pendingMainCalls.delete(requestId);
        }
      }
    });

    child.on("exit", () => {
      this.retireSession(sessionId, host);
      this.rejectPending(host);
    });
    child.on("error", () => {
      this.retireSession(sessionId, host);
      this.rejectPending(host);
    });

    await this.callWorker(sessionId, "init", [
      [...workspaceRoots],
      initialState,
      [...this.manifests.values()],
    ]);
  }

  async stopSession(sessionId: string): Promise<void> {
    const host = this.sessions.get(sessionId);
    if (!host) return;
    host.stopping ??= this.shutdownSession(sessionId, host);
    await host.stopping;
  }

  private async shutdownSession(sessionId: string, host: SessionHost): Promise<void> {
    const shutdown = this.callWorker(sessionId, "shutdown");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        shutdown.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.retireSession(sessionId, host);
      this.rejectPending(host);
      host.process.kill();
    }
  }

  async activateByEvent(sessionId: string, event: string): Promise<void> {
    await this.callWorker(sessionId, "activateByEvent", [event]);
  }

  async executeCommand<T = unknown>(
    sessionId: string,
    command: string,
    ...args: unknown[]
  ): Promise<T> {
    return this.executeCommandWithSignal<T>(sessionId, command, args);
  }

  async executeCommandWithSignal<T = unknown>(
    sessionId: string,
    command: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!command.startsWith("__")) {
      await this.activateByEvent(sessionId, `onCommand:${command}`);
    }
    return (await this.callWorker(sessionId, "executeCommand", [command, ...args], signal)) as T;
  }

  async syncMcpProvider(sessionId: string, providerId: string): Promise<void> {
    const host = this.sessions.get(sessionId);
    this.dropMcpProvider(sessionId, providerId);
    const definitions = await this.executeCommand<unknown>(
      sessionId,
      `__mcp.provide.${providerId}`,
    );
    if (this.sessions.get(sessionId) !== host || host?.stopping || !Array.isArray(definitions)) {
      return;
    }
    const disposers: (() => void)[] = [];
    this.mcpProviders.set(this.mcpProviderKey(sessionId, providerId), disposers);
    definitions.forEach((definition, index) => {
      const config = toMcpServerConfig(`ext:${sessionId}:${providerId}:${index}`, definition);
      if (config !== undefined) {
        disposers.push(this.mcp.registerServer(config));
      }
    });
  }

  dropMcpProvider(sessionId: string, providerId: string): void {
    const key = this.mcpProviderKey(sessionId, providerId);
    const disposers = this.mcpProviders.get(key);
    if (disposers === undefined) {
      return;
    }
    this.mcpProviders.delete(key);
    for (const dispose of disposers) {
      dispose();
    }
  }

  private dropSessionMcpProviders(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.mcpProviders.keys()]) {
      if (key.startsWith(prefix)) {
        this.dropMcpProvider(sessionId, key.slice(prefix.length));
      }
    }
  }

  private mcpProviderKey(sessionId: string, providerId: string): string {
    return `${sessionId}\u0000${providerId}`;
  }

  resolveMainCall(requestId: string, result?: unknown, error?: string | Error): void {
    const entry = this.pendingMainCalls.get(requestId);
    if (!entry) return;
    this.pendingMainCalls.delete(requestId);
    if (error !== undefined) entry.reject(typeof error === "string" ? new Error(error) : error);
    else entry.resolve(result);
  }

  private async syncExtensions(): Promise<void> {
    this.contributionRevision.value = randomUUID();
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        this.callWorker(sessionId, "syncExtensions", [[...this.manifests.values()]]),
      ),
    );
  }

  private rejectPending(host: SessionHost): void {
    const error = new Error("Extension host stopped");
    for (const entry of host.pending.values()) entry.reject(error);
    host.pending.clear();
    for (const [id, entry] of this.pendingMainCalls) {
      if (entry.host !== host) continue;
      entry.reject(error);
      this.pendingMainCalls.delete(id);
    }
  }

  private retireSession(sessionId: string, host: SessionHost): void {
    if (this.sessions.get(sessionId) !== host) return;
    this.sessions.delete(sessionId);
    this.dropSessionMcpProviders(sessionId);
    try {
      this.hooks.sessionStopped.run(sessionId);
    } catch (error) {
      console.error(error);
    }
  }

  private async callWorker(
    sessionId: string,
    method: string,
    args: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const host = this.sessions.get(sessionId);
    if (!host) throw new Error(`Extension host not started for session: ${sessionId}`);
    if (!host.process.connected) throw new Error("Extension host disconnected");
    const id = host.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!host.pending.delete(id)) return;
        reject(signal?.reason);
        if (host.process.connected) {
          host.process.send({ type: "cancel", id } satisfies RpcCancel, () => {});
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const pending = {
        resolve(value: unknown) {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject(error: Error) {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      host.pending.set(id, pending);
      try {
        host.process.send({ type: "request", id, method, args } satisfies RpcRequest, (error) => {
          if (error && host.pending.delete(id)) pending.reject(error);
        });
      } catch (error) {
        host.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
