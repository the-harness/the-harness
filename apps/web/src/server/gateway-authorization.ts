import type { GatewayPeer } from "@harness/gateway";

export function authorizeGatewayRequest(peer: GatewayPeer, route: string): boolean {
  return (
    peer.role === "owner" ||
    (!route.startsWith("state-sync:") && route !== "extHost.importLegacySecrets")
  );
}
