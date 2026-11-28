import { AuthService, type AuthContext, type AuthResult } from "@harness/auth";
import { getCurrentScope, onScopeDispose } from "reactivity";

export interface OAuth2TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly tokenType?: string;
}

export interface OAuth2AuthOptions {
  readonly grantType?: "authorization_code" | "device_code" | "client_credentials";
  readonly clientId: string;
  readonly tokenUrl: string;
  readonly authorizationUrl?: string;
  readonly deviceAuthorizationUrl?: string;
  readonly scopes?: readonly string[];
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly accountId?: string;
  readonly refreshMarginMs?: number;
  readonly fetch?: typeof fetch;
}

async function waitForRefresh(
  refresh: Promise<OAuth2TokenSet>,
  signal: AbortSignal,
): Promise<OAuth2TokenSet> {
  const canceled = Promise.withResolvers<never>();
  const cancel = () => canceled.reject(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await Promise.race([refresh, canceled.promise]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function disposedError(): DOMException {
  return new DOMException("OAuth2 auth service is disposed", "AbortError");
}

export class OAuth2AuthService extends AuthService {
  readonly options: OAuth2AuthOptions;

  protected token: OAuth2TokenSet | undefined;
  protected inflight: Promise<OAuth2TokenSet> | undefined;
  private readonly owner = getCurrentScope();
  private tokenLifetime = new AbortController();

  constructor(options: OAuth2AuthOptions) {
    super();
    this.options = options;
    if (options.accessToken !== undefined) {
      this.token = {
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresAt: options.expiresAt,
      };
    }
    if (this.owner) {
      onScopeDispose(() => {
        this.token = undefined;
        this.inflight = undefined;
        this.tokenLifetime.abort(disposedError());
      });
    }
  }

  getToken(): OAuth2TokenSet | undefined {
    return this.token;
  }

  setToken(token: OAuth2TokenSet | undefined): void {
    this.assertActive();
    const previous = this.tokenLifetime;
    this.tokenLifetime = new AbortController();
    this.inflight = undefined;
    this.token = token;
    previous.abort(new DOMException("OAuth2 token was replaced or cleared", "AbortError"));
  }

  override async authorize(ctx?: AuthContext): Promise<AuthResult> {
    this.assertActive();
    ctx?.signal?.throwIfAborted();
    let current = this.token;
    const refreshMarginMs = this.options.refreshMarginMs ?? 60_000;

    if (
      current !== undefined &&
      current.expiresAt !== undefined &&
      current.refreshToken !== undefined &&
      Date.now() + refreshMarginMs >= current.expiresAt
    ) {
      const lifetime = this.tokenLifetime.signal;
      const signal = ctx?.signal ? AbortSignal.any([lifetime, ctx.signal]) : lifetime;
      signal.throwIfAborted();
      current = await waitForRefresh(this.refresh(current.refreshToken, lifetime), signal);
      signal.throwIfAborted();
    }

    if (!current?.accessToken) {
      return { headers: {}, identityKey: this.options.accountId };
    }

    const scheme = current.tokenType ?? "Bearer";
    return {
      headers: { Authorization: `${scheme} ${current.accessToken}` },
      apiKey: current.accessToken,
      identityKey:
        this.options.accountId ?? `oauth2:${this.options.clientId}:${current.accessToken}`,
    };
  }

  protected refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuth2TokenSet> {
    this.assertActive();
    if (this.inflight !== undefined) {
      return this.inflight;
    }

    const request = async (): Promise<OAuth2TokenSet> => {
      signal?.throwIfAborted();
      const fetchFn = this.options.fetch ?? globalThis.fetch;
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.options.clientId,
        refresh_token: refreshToken,
      });
      const response = await fetchFn(this.options.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal,
      });
      if (!response.ok) {
        throw new Error(`OAuth2 token refresh failed with HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const accessToken = typeof data["access_token"] === "string" ? data["access_token"] : "";
      if (!accessToken) {
        throw new Error("OAuth2 token response missing access_token");
      }
      const nextRefreshToken =
        typeof data["refresh_token"] === "string" ? data["refresh_token"] : refreshToken;
      const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : undefined;
      const tokenType = typeof data["token_type"] === "string" ? data["token_type"] : "Bearer";
      const next: OAuth2TokenSet = {
        accessToken,
        refreshToken: nextRefreshToken,
        expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1_000 : undefined,
        tokenType,
      };
      signal?.throwIfAborted();
      if (this.inflight === promise) this.token = next;
      return next;
    };
    const promise = Promise.resolve()
      .then(request)
      .finally(() => {
        if (this.inflight === promise) this.inflight = undefined;
      });

    this.inflight = promise;
    return promise;
  }

  private assertActive(): void {
    if (this.owner?.active === false) throw disposedError();
  }
}
