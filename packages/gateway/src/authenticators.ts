import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayAuthenticator, GatewayPeer, SurfaceRole } from "./index.ts";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

export interface TokenEntry {
  readonly token: string;
  readonly role?: SurfaceRole;
  readonly surfaceId?: string;
}

export interface TokenAuthenticatorOptions {
  readonly tokens: readonly (string | TokenEntry)[];
  readonly queryParam?: string;
}

export function createTokenAuthenticator(options: TokenAuthenticatorOptions): GatewayAuthenticator {
  const queryParam = options.queryParam ?? "token";
  const entries: TokenEntry[] = options.tokens.map((t) =>
    typeof t === "string" ? { token: t, role: "owner" } : t,
  );

  return {
    authenticate(req: IncomingMessage): GatewayPeer | null {
      const authHeader = req.headers.authorization;
      let candidate: string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        candidate = authHeader.slice(7).trim();
      } else {
        const url = new URL(req.url ?? "/", "http://localhost");
        candidate = url.searchParams.get(queryParam) ?? undefined;
      }
      if (!candidate) return null;

      for (const entry of entries) {
        if (safeEqual(candidate, entry.token)) {
          return {
            surfaceId: entry.surfaceId ?? randomUUID(),
            role: entry.role ?? "owner",
          };
        }
      }
      return null;
    },
  };
}

export interface BasicAuthAuthenticatorOptions {
  readonly username?: string;
  readonly password: string;
  readonly role?: SurfaceRole;
}

export function createBasicAuthAuthenticator(
  options: BasicAuthAuthenticatorOptions,
): GatewayAuthenticator {
  const expectedUser = options.username ?? "";
  return {
    authenticate(req: IncomingMessage): GatewayPeer | null {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Basic ")) return null;
      const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx === -1) return null;
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (expectedUser && !safeEqual(user, expectedUser)) return null;
      if (!safeEqual(pass, options.password)) return null;
      return {
        surfaceId: randomUUID(),
        role: options.role ?? "owner",
      };
    },
  };
}

export interface CookieAuthenticatorOptions {
  readonly cookieName?: string;
  readonly verifySession: (sessionId: string) => Promise<GatewayPeer | null> | GatewayPeer | null;
}

export function createCookieAuthenticator(
  options: CookieAuthenticatorOptions,
): GatewayAuthenticator {
  const cookieName = options.cookieName ?? "harness_session";
  return {
    async authenticate(req: IncomingMessage): Promise<GatewayPeer | null> {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies[cookieName];
      if (!sessionId) return null;
      return options.verifySession(sessionId);
    },
  };
}

export function createLoopbackAuthenticator(role: SurfaceRole = "owner"): GatewayAuthenticator {
  return {
    authenticate(req: IncomingMessage): GatewayPeer | null {
      const addr = req.socket.remoteAddress;
      if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
        return { surfaceId: randomUUID(), role };
      }
      return null;
    },
  };
}

export interface PasswordAuthHandlerOptions {
  readonly password?: string;
  readonly authRequired?: boolean;
  readonly basePath?: string;
  readonly cookieName?: string;
  readonly role?: SurfaceRole;
}

export interface PasswordAuthHandler {
  readonly authenticator: GatewayAuthenticator;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createPasswordAuthHandler(
  options: PasswordAuthHandlerOptions,
): PasswordAuthHandler {
  const basePath = options.basePath ?? "/api/auth";
  const cookieName = options.cookieName ?? "harness_session";
  const sessions = new Map<string, GatewayPeer>();
  const authenticator = createCookieAuthenticator({
    cookieName,
    verifySession: (sid) => sessions.get(sid) ?? null,
  });

  return {
    authenticator,
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === `${basePath}/status` && req.method === "GET") {
        const authRequired = options.authRequired ?? Boolean(options.password);
        const sid = parseCookies(req.headers.cookie)[cookieName];
        const authenticated = !authRequired || Boolean(sid && sessions.has(sid));
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ authRequired, authenticated }));
        return true;
      }

      if (url.pathname === `${basePath}/login` && req.method === "POST") {
        if (!options.password) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Password login is not configured" }));
          return true;
        }
        try {
          const body = await readJsonBody(req);
          const input = typeof body.password === "string" ? body.password : "";
          if (!safeEqual(input, options.password)) {
            res.statusCode = 401;
            res.end(JSON.stringify({ ok: false, error: "Invalid password" }));
            return true;
          }
          const sid = randomUUID();
          sessions.set(sid, { surfaceId: randomUUID(), role: options.role ?? "owner" });
          res.setHeader(
            "set-cookie",
            `${cookieName}=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax`,
          );
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
        }
        return true;
      }

      if (url.pathname === `${basePath}/logout` && req.method === "POST") {
        const sid = parseCookies(req.headers.cookie)[cookieName];
        if (sid) sessions.delete(sid);
        res.setHeader("set-cookie", `${cookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      return false;
    },
  };
}
