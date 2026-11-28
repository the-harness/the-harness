# @harness/gateway

```ts
export type SurfaceRole = "owner" | "observer";

export interface GatewayPeer {
  readonly surfaceId: string;
  readonly role: SurfaceRole;
}

/** Extensible: implement custom HTTP upgrade authentication strategies. */
export interface GatewayAuthenticator {
  authenticate(req: IncomingMessage): Promise<GatewayPeer | null> | GatewayPeer | null;
}

export interface AttachGatewayOptions {
  /** WebSocket upgrade path; defaults to `/api/transport/ws`. */
  readonly path?: string;
  /** Optional request authorization hook; defaults to blocking `state-sync:` writes for `observer`. */
  readonly authorizeRequest?: (peer: GatewayPeer, route: string) => boolean;
  /** Optional composable authenticators evaluated in order during HTTP upgrade. */
  readonly authenticators?: readonly GatewayAuthenticator[];
}

export type GatewayTarget =
  | HarnessRegistry
  | ((harnessId?: string, peer?: GatewayPeer) => Promise<RootServerTransport>);

export function attachGateway(
  httpServer: HttpServer,
  target: GatewayTarget,
  options?: AttachGatewayOptions,
): void;

export interface HarnessMetadata {
  readonly harnessId: string;
  readonly name: string;
  readonly kind: string;
  readonly location?: string;
}

/** Extensible: registration supplied by a Harness runtime adapter. */
export interface HarnessRegistration {
  readonly meta: HarnessMetadata;
  resolveRuntime(peer?: GatewayPeer): Promise<RootServerTransport>;
  dispose?(): Promise<void> | void;
}

export interface HarnessRegistry {
  register(registration: HarnessRegistration): void; // Registers a new harness ID and rejects duplicate active IDs.
  unregister(harnessId: string): Promise<void>;
  list(): readonly HarnessMetadata[];
  setDefault(harnessId: string): void;
  getDefaultId(): string | undefined;
  resolve(harnessId?: string, peer?: GatewayPeer): Promise<RootServerTransport>; // Resolves only while the selected registration is current.
}

export function createHarnessRegistry(): HarnessRegistry;

export function createTokenAuthenticator(options: {
  readonly tokens: readonly (
    | string
    | { readonly token: string; readonly role?: SurfaceRole; readonly surfaceId?: string }
  )[];
  readonly queryParam?: string;
}): GatewayAuthenticator;

export function createBasicAuthAuthenticator(options: {
  readonly username?: string;
  readonly password: string;
  readonly role?: SurfaceRole;
}): GatewayAuthenticator;

export function createCookieAuthenticator(options: {
  readonly cookieName?: string;
  readonly verifySession: (sessionId: string) => Promise<GatewayPeer | null> | GatewayPeer | null;
}): GatewayAuthenticator;

export function createLoopbackAuthenticator(role?: SurfaceRole): GatewayAuthenticator;

export function createPasswordAuthHandler(options: {
  readonly password?: string;
  readonly authRequired?: boolean;
  readonly basePath?: string;
  readonly cookieName?: string;
  readonly role?: SurfaceRole;
}): {
  readonly authenticator: GatewayAuthenticator;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export function createKeyedQueue(): {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

export function createIdempotentArbiter(): {
  claim<T>(
    key: string,
    fn: () => Promise<T> | T,
  ): Promise<{ readonly claimed: true; readonly result: T } | { readonly claimed: false }>;
  release(key: string): void;
};
```
