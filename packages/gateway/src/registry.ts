import type { RootServerTransport } from "@harness/transport";
import type { GatewayPeer } from "./index.ts";

export interface HarnessMetadata {
  readonly harnessId: string;
  readonly name: string;
  readonly kind: string;
  readonly location?: string;
}

// Extensible: runtime adapters provide their own resolution and disposal.
export interface HarnessRegistration {
  readonly meta: HarnessMetadata;
  resolveRuntime(peer?: GatewayPeer): Promise<RootServerTransport>;
  dispose?(): Promise<void> | void;
}

export interface HarnessRegistry {
  register(registration: HarnessRegistration): void;
  unregister(harnessId: string): Promise<void>;
  list(): readonly HarnessMetadata[];
  setDefault(harnessId: string): void;
  getDefaultId(): string | undefined;
  resolve(harnessId?: string, peer?: GatewayPeer): Promise<RootServerTransport>;
}

export function createHarnessRegistry(): HarnessRegistry {
  const entries = new Map<string, { readonly registration: HarnessRegistration }>();
  let defaultHarnessId: string | undefined;

  return {
    register(registration: HarnessRegistration): void {
      const { harnessId } = registration.meta;
      if (entries.has(harnessId)) {
        throw new Error(`Harness '${harnessId}' is already registered`);
      }
      entries.set(harnessId, { registration });
      if (defaultHarnessId === undefined) {
        defaultHarnessId = harnessId;
      }
    },

    async unregister(harnessId: string): Promise<void> {
      const existing = entries.get(harnessId);
      if (!existing) return;
      entries.delete(harnessId);
      if (defaultHarnessId === harnessId) {
        defaultHarnessId = entries.keys().next().value;
      }
      await existing.registration.dispose?.();
    },

    list(): readonly HarnessMetadata[] {
      return [...entries.values()].map(({ registration }) => registration.meta);
    },

    setDefault(harnessId: string): void {
      if (!entries.has(harnessId)) {
        throw new Error(`Unknown harnessId: ${harnessId}`);
      }
      defaultHarnessId = harnessId;
    },

    getDefaultId(): string | undefined {
      return defaultHarnessId;
    },

    async resolve(harnessId?: string, peer?: GatewayPeer): Promise<RootServerTransport> {
      const targetId = harnessId ?? defaultHarnessId;
      if (!targetId) {
        throw new Error("No harness registered");
      }
      const entry = entries.get(targetId);
      if (!entry) {
        throw new Error(`Unknown harnessId: ${targetId}`);
      }
      const runtime = await entry.registration.resolveRuntime(peer);
      if (entries.get(targetId) !== entry) {
        throw new Error(`Harness '${targetId}' was unregistered during runtime resolution`);
      }
      return runtime;
    },
  };
}
