import { inject } from "@harness/di";
import { defineRpcContract, rpc, RpcServerService } from "@harness/rpc";
import { defineStreamContract, stream, StreamServerService } from "@harness/stream";
import { getCurrentScope, onScopeDispose } from "reactivity";
import { z } from "zod";
import type {
  StateSyncContract,
  StateSyncEndpoint,
  StateSyncEndpoints,
  StateSyncHost,
  StateSyncStreamMessage,
} from "./contract.ts";

export interface StateSyncContext {
  readonly scope: readonly string[];
  readonly signal?: AbortSignal;
}

export type StateSyncHostFor<E extends StateSyncEndpoint<any, any, any, boolean>> =
  E extends StateSyncEndpoint<any, infer THost, any, any> ? THost : never;

export type StateSyncHosts<T extends StateSyncEndpoints> = {
  readonly [K in keyof T]: (ctx: StateSyncContext) => StateSyncHostFor<T[K]>;
};

async function* streamHost(
  host: StateSyncHost,
  signal: AbortSignal,
): AsyncGenerator<StateSyncStreamMessage> {
  if (signal.aborted) return;
  let seq = 0;
  const queue: StateSyncStreamMessage[] = [
    { type: "snapshot", seq: seq++, snapshot: host.snapshot() },
  ];
  let notify: (() => void) | undefined;

  let unsubscribe: (() => void) | undefined = host.subscribe((frame) => {
    queue.push({ type: "frame", seq: seq++, frame });
    notify?.();
    notify = undefined;
  });

  const onAbort = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    queue.length = 0;
    notify?.();
    notify = undefined;
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
  }
}

export class StateSyncServerService {
  private readonly rpcServer = inject(RpcServerService);
  private readonly streamServer = inject(StreamServerService);

  useHandlers<T extends StateSyncEndpoints>(
    contract: StateSyncContract<T>,
    hosts: StateSyncHosts<T>,
  ): void {
    if (getCurrentScope() === undefined) {
      throw new Error("useHandlers() requires an active EffectScope");
    }
    const lifetime = new AbortController();
    onScopeDispose(() => lifetime.abort());

    for (const [name, endpoint] of Object.entries(contract.endpoints)) {
      const resolveHost = hosts[name as keyof T];
      const namespace = `state-sync:${contract.namespace}`;
      const isReadonly = endpoint.readonly;

      const rpcContract = defineRpcContract(namespace, {
        [name]: rpc.call(z.unknown(), z.unknown()),
      });
      this.rpcServer.useHandlers(rpcContract, {
        [name]: (patch, ctx) => {
          if (isReadonly) {
            throw new Error(
              `State-sync path is read-only: /state-sync/${contract.namespace}.${name}`,
            );
          }
          const signal = ctx.signal
            ? AbortSignal.any([lifetime.signal, ctx.signal])
            : lifetime.signal;
          signal.throwIfAborted();
          const host = resolveHost({ scope: ctx.scope, signal });
          signal.throwIfAborted();
          if (typeof host.apply !== "function") {
            throw new Error(`State-sync host does not support patches: ${namespace}.${name}`);
          }
          return host.apply(patch);
        },
      });

      const streamContract = defineStreamContract(namespace, {
        [name]: stream.channel(z.void(), z.custom<StateSyncStreamMessage>()),
      });
      this.streamServer.useHandlers(streamContract, {
        [name]: async function* (_input, ctx) {
          const signal = ctx.signal
            ? AbortSignal.any([lifetime.signal, ctx.signal])
            : lifetime.signal;
          if (signal.aborted) return;
          yield* streamHost(resolveHost({ scope: ctx.scope, signal }), signal);
        },
      });
    }
  }
}
