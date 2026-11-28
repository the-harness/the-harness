import type { Transport } from "@harness/transport";
import { getCurrentScope, onScopeDispose, type EffectScope } from "reactivity";

export interface StateSyncStreamMessage<TSnapshot = unknown, TFrame = unknown> {
  readonly type: "snapshot" | "frame";
  readonly seq?: number;
  readonly snapshot?: TSnapshot;
  readonly frame?: TFrame;
}

export interface StateSyncClientPaths {
  readonly rpcPath: string;
  readonly streamPath: string;
}

export interface StateSyncClientTarget<TSnapshot = unknown, TFrame = unknown> {
  reset(snapshot: TSnapshot): void;
  receive(frame: TFrame): void;
}

// 可拓展接口：外部包可实现自定义同步数据结构的服务端宿主。
export interface StateSyncHost<TSnapshot = unknown, TFrame = unknown, TPatch = unknown> {
  snapshot(): TSnapshot;
  subscribe(listener: (frame: TFrame) => void): () => void;
  apply?(patch: TPatch): unknown;
}

export interface StateSyncEndpointOptions<TReadonly extends boolean = boolean> {
  readonly readonly?: TReadonly;
}

// 可拓展接口：外部包可实现自定义的 StateSyncEndpoint 接入任意同步数据结构。
export interface StateSyncEndpoint<
  TClient = unknown,
  THost extends StateSyncHost<any, any, any> = StateSyncHost<any, any, any>,
  TPatch = unknown,
  TReadonly extends boolean = boolean,
> {
  readonly kind: string;
  readonly readonly: TReadonly;
  // Called inside an active EffectScope; the client must release its resources when that scope stops.
  createClient(transport: Transport, paths: StateSyncClientPaths): TClient;
  readonly __host?: THost;
  readonly __patch?: TPatch;
}

export type StateSyncEndpoints = Record<string, StateSyncEndpoint<any, any, any, boolean>>;

export interface StateSyncContract<T extends StateSyncEndpoints = StateSyncEndpoints> {
  readonly namespace: string;
  readonly endpoints: T;
}

export type StateSyncClient<T extends StateSyncEndpoints> = {
  readonly [K in keyof T]: T[K] extends StateSyncEndpoint<infer TClient, any, any, any>
    ? TClient
    : never;
};

export function assertActiveScope(owner: string): EffectScope {
  const scope = getCurrentScope();
  if (scope === undefined) {
    throw new Error(`${owner} must be created inside an active EffectScope`);
  }
  return scope;
}

export function createScopedPatchSender(transport: Transport, rpcPath: string) {
  assertActiveScope("createScopedPatchSender()");
  const controller = new AbortController();
  const { signal } = controller;
  onScopeDispose(() => controller.abort());
  return async (patch: unknown): Promise<unknown> => {
    if (signal.aborted) return;
    try {
      return await transport.request(rpcPath, patch, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };
}

function waitToReconnect(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 1_000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function connectStreamEndpoint<TSnapshot, TFrame>(
  transport: Transport,
  streamPath: string,
  target: StateSyncClientTarget<TSnapshot, TFrame>,
): void {
  assertActiveScope("connectStreamEndpoint()");
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        let lastSeq = -1;
        for await (const msg of transport.openStream(streamPath, undefined, controller.signal)) {
          if (controller.signal.aborted) return;
          const payload = msg as StateSyncStreamMessage<TSnapshot, TFrame>;
          if (payload.type === "snapshot") {
            lastSeq = payload.seq ?? -1;
            target.reset(payload.snapshot as TSnapshot);
          } else if (payload.type === "frame") {
            if (payload.seq !== undefined) {
              if (payload.seq <= lastSeq) continue;
              lastSeq = payload.seq;
            }
            target.receive(payload.frame as TFrame);
          }
        }
      } catch {
        // The next subscription starts with a fresh snapshot.
      }
      if (!controller.signal.aborted) {
        await waitToReconnect(controller.signal);
      }
    }
  })();
}

export function defineStateSyncContract<T extends StateSyncEndpoints>(
  namespace: string,
  endpoints: T,
): StateSyncContract<T> {
  return { namespace, endpoints };
}
