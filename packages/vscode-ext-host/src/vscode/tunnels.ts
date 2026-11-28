import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  type Event,
} from "@harness/vscode-types";
type Address = { host: string; port: number };
type TunnelOptions = {
  remoteAddress: Address;
  localAddressPort?: number;
  label?: string;
  privacy?: string;
  protocol?: string;
};
type Tunnel = {
  remoteAddress: Address;
  localAddress: Address | string;
  privacy?: string;
  protocol?: string;
  onDidDispose: Event<void>;
  dispose(): void | PromiseLike<void>;
};
type Provider = {
  provideTunnel(
    options: TunnelOptions,
    creationOptions: { elevationRequired: boolean },
    token: CancellationTokenSource["token"],
  ): Tunnel | undefined | PromiseLike<Tunnel | undefined>;
};

export function createTunnelApi() {
  const providers = new Set<Provider>();
  const tunnels = new Set<Tunnel>();
  const changed = new EventEmitter<void>();
  return {
    async registerTunnelProvider(provider: Provider, _information?: unknown) {
      providers.add(provider);
      return new Disposable(() => {
        providers.delete(provider);
      });
    },
    async openTunnel(options: TunnelOptions): Promise<Tunnel> {
      const provider = [...providers][0];
      if (!provider) throw new Error("No tunnel provider is registered");
      const cancellation = new CancellationTokenSource();
      try {
        const tunnel = await provider.provideTunnel(
          options,
          { elevationRequired: false },
          cancellation.token,
        );
        if (!tunnel) throw new Error("Tunnel provider did not create a tunnel");
        tunnels.add(tunnel);
        const subscription = tunnel.onDidDispose(() => {
          tunnels.delete(tunnel);
          subscription.dispose();
          changed.fire();
        });
        changed.fire();
        return tunnel;
      } finally {
        cancellation.dispose();
      }
    },
    get tunnels() {
      return Promise.resolve(
        [...tunnels].map((tunnel) => ({
          remoteAddress: tunnel.remoteAddress,
          localAddress: tunnel.localAddress,
          privacy: tunnel.privacy,
          protocol: tunnel.protocol,
        })),
      );
    },
    onDidChangeTunnels: changed.event,
  };
}
