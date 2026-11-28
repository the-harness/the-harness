import { inject } from "@harness/di";
import { LlmService } from "@harness/llm";
import { ProviderManager } from "@harness/model-provider";
import { RpcServerService } from "@harness/rpc";
import { StateSyncServerService } from "@harness/state-sync";
import { StreamServerService } from "@harness/stream";
import { effectScope, onScopeDispose } from "reactivity";
import { createMainThreadLanguageModels } from "./main-thread/language-models.ts";
import { useExtensionSecrets } from "./node/secrets.ts";
import {
  ExtHostRpcContract,
  ExtHostStateSyncContract,
  ExtHostStreamContract,
  type ExtHostMainCallEvent,
} from "./rpc.ts";
import { ExtensionHostService } from "./service.ts";
import { decodeExtHostError } from "./wire-error.ts";

export function useExtHostHandlers(): void {
  const host = inject(ExtensionHostService);
  inject(StateSyncServerService).useHandlers(ExtHostStateSyncContract, {
    contributionsVersion: () => host.contributionsVersion,
  });
  const importLegacySecrets = useExtensionSecrets(host);
  const models = createMainThreadLanguageModels(inject(LlmService), inject(ProviderManager), host);
  const stopRouter = host.registerMainThreadRouter(async (sessionId, method, args) => {
    return models.handle(sessionId, method, args);
  });
  host.hooks.sessionStopped.use((sessionId, next) => {
    void models.clearSession(sessionId, true).catch(console.error);
    return next();
  });
  onScopeDispose(() => {
    stopRouter();
    void models.dispose().catch(console.error);
  });

  const subscribedHosts = new Map<string, AbortSignal>();
  inject(RpcServerService).useHandlers(ExtHostRpcContract, {
    scanExtensions: (input) => host.scanExtensions(input.extensionsDir),
    removeContentExtension: (input) => host.removeContentExtension(input.extensionId),
    removeExtension: (input) => host.removeExtension(input.extensionId),
    getContributions: () => host.getContributions(),
    startSession: (input) => {
      const signal = subscribedHosts.get(input.sessionId);
      if (!signal) throw new Error("Extension host must subscribe to events before starting");
      return host.startSession(input.sessionId, input.workspaceRoots, input.initialState, signal);
    },
    stopSession: (input) => host.stopSession(input.sessionId),
    activateByEvent: (input) => host.activateByEvent(input.sessionId, input.event),
    executeCommand: (input, ctx) =>
      host.executeCommandWithSignal(input.sessionId, input.command, input.args ?? [], ctx.signal),
    syncMcpProvider: (input) => host.syncMcpProvider(input.sessionId, input.providerId),
    dropMcpProvider: (input) => host.dropMcpProvider(input.sessionId, input.providerId),
    importLegacySecrets,
    resolveMainCall: (input) =>
      host.resolveMainCall(
        input.requestId,
        input.result,
        input.error === undefined
          ? undefined
          : decodeExtHostError({ ...input, error: input.error }),
      ),
  });

  inject(StreamServerService).useHandlers(ExtHostStreamContract, {
    events: async function* (input, ctx) {
      if (ctx.signal?.aborted) return;
      const { sessionId } = input;
      if (subscribedHosts.has(sessionId))
        throw new Error("Extension host already has an event stream");
      const lifetime = new AbortController();
      subscribedHosts.set(sessionId, lifetime.signal);
      const queue: ExtHostMainCallEvent[] = [];
      let wake: (() => void) | undefined;
      let stopped = false;
      const unsubscribe = host.onMainThreadCall(async (target, method, args, requestId) => {
        if (target === sessionId) {
          queue.push({ sessionId, requestId, method, args });
          wake?.();
        }
      });
      const hooks = effectScope();
      hooks.run(() => {
        host.hooks.sessionStopped.use((target, next) => {
          if (target === sessionId) {
            stopped = true;
            lifetime.abort();
            wake?.();
          }
          return next();
        });
      });
      const onAbort = () => {
        lifetime.abort();
        wake?.();
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        yield { ready: true };
        while (!ctx.signal?.aborted && !stopped) {
          if (queue.length) yield queue.shift()!;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        hooks.stop();
        lifetime.abort();
        try {
          await host.stopSession(sessionId);
        } finally {
          subscribedHosts.delete(sessionId);
        }
      }
    },
  });
}
