import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { RootServerTransport } from "@harness/transport";
import { WebSocketServer, type WebSocket } from "ws";
import type { HarnessRegistry } from "./registry.ts";

export {
  createHarnessRegistry,
  type HarnessMetadata,
  type HarnessRegistration,
  type HarnessRegistry,
} from "./registry.ts";

export {
  createIdempotentArbiter,
  createKeyedQueue,
  type ArbiterResult,
  type IdempotentArbiter,
  type KeyedQueue,
} from "./concurrency.ts";

export {
  createBasicAuthAuthenticator,
  createCookieAuthenticator,
  createLoopbackAuthenticator,
  createPasswordAuthHandler,
  createTokenAuthenticator,
  type BasicAuthAuthenticatorOptions,
  type CookieAuthenticatorOptions,
  type PasswordAuthHandler,
  type PasswordAuthHandlerOptions,
  type TokenAuthenticatorOptions,
  type TokenEntry,
} from "./authenticators.ts";

export type SurfaceRole = "owner" | "observer";

export interface GatewayPeer {
  readonly surfaceId: string;
  readonly role: SurfaceRole;
}

// 可拓展接口：外部可实现自定义 upgrade 鉴权策略并组合使用。
export interface GatewayAuthenticator {
  authenticate(req: IncomingMessage): Promise<GatewayPeer | null> | GatewayPeer | null;
}

export interface AttachGatewayOptions {
  readonly path?: string;
  readonly authorizeRequest?: (peer: GatewayPeer, route: string) => boolean;
  readonly authenticators?: readonly GatewayAuthenticator[];
}

interface TransportFrame {
  readonly type: string;
  readonly id: string;
  readonly harnessId?: string;
  readonly surfaceId?: string;
  readonly role?: SurfaceRole;
  readonly scope?: readonly string[];
  readonly path?: string;
  readonly body?: unknown;
}

export type GatewayTarget =
  | HarnessRegistry
  | ((harnessId?: string, peer?: GatewayPeer) => Promise<RootServerTransport>);

export function attachGateway(
  httpServer: HttpServer,
  target: GatewayTarget,
  options?: AttachGatewayOptions,
): void {
  const resolveRuntime =
    typeof target === "function"
      ? target
      : (harnessId?: string, peer?: GatewayPeer) => target.resolve(harnessId, peer);
  const wsPath = options?.path ?? "/api/transport/ws";
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== wsPath) return;

    let authenticatedPeer: GatewayPeer | undefined;
    const authenticators = options?.authenticators;
    if (authenticators && authenticators.length > 0) {
      try {
        for (const auth of authenticators) {
          const result = await auth.authenticate(req);
          if (result) {
            authenticatedPeer = result;
            break;
          }
        }
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!authenticatedPeer) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, authenticatedPeer);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, authenticatedPeer?: GatewayPeer) => {
    const activeRequests = new Map<string, AbortController>();
    const activeStreams = new Map<string, AbortController>();
    let peer: GatewayPeer = authenticatedPeer ?? { surfaceId: randomUUID(), role: "owner" };

    const sendFrame = (frame: unknown) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    };

    ws.on("message", async (raw) => {
      let frame: TransportFrame;
      try {
        frame = JSON.parse(raw.toString()) as TransportFrame;
      } catch {
        return;
      }

      if (frame.type === "hello") {
        peer = {
          surfaceId: authenticatedPeer ? peer.surfaceId : frame.surfaceId || peer.surfaceId,
          role: authenticatedPeer ? peer.role : frame.role === "observer" ? "observer" : "owner",
        };
        sendFrame({
          type: "ready",
          id: frame.id,
          surfaceId: peer.surfaceId,
          role: peer.role,
        });
        return;
      }

      if (frame.type === "ping") {
        sendFrame({ type: "pong", id: frame.id });
        return;
      }

      if (frame.type === "request:cancel") {
        const request = activeRequests.get(frame.id);
        activeRequests.delete(frame.id);
        request?.abort();
        return;
      }

      if (frame.type === "request") {
        if (activeRequests.has(frame.id)) return;
        const request = new AbortController();
        activeRequests.set(frame.id, request);
        try {
          const route = (frame.path ?? "").replace(/^\/rpc\//, "");
          const allowed = options?.authorizeRequest
            ? options.authorizeRequest(peer, route)
            : !(peer.role === "observer" && route.startsWith("state-sync:"));
          if (!allowed) {
            sendFrame({
              type: "response",
              id: frame.id,
              ok: false,
              error: "Forbidden: observer role cannot perform this operation",
            });
            return;
          }
          const serverTransport = await resolveRuntime(frame.harnessId, peer);
          if (request.signal.aborted) return;
          const result = await serverTransport.handleCall(
            frame.scope ?? [],
            route,
            frame.body,
            request.signal,
          );
          if (!request.signal.aborted) {
            sendFrame({ type: "response", id: frame.id, ok: true, result });
          }
        } catch (error) {
          if (request.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          sendFrame({
            type: "response",
            id: frame.id,
            ok: false,
            error: message,
          });
        } finally {
          if (activeRequests.get(frame.id) === request) activeRequests.delete(frame.id);
        }
        return;
      }

      if (frame.type === "stream.open" || frame.type === "stream:open") {
        const useColon = frame.type === "stream:open";
        const ac = new AbortController();
        activeStreams.set(frame.id, ac);
        try {
          const serverTransport = await resolveRuntime(frame.harnessId, peer);
          const rawPath = frame.path ?? "";
          const path = useColon ? rawPath : rawPath.replace(/^\/stream/, "");
          for await (const chunk of serverTransport.handleStream(
            frame.scope ?? [],
            path,
            frame.body,
            ac.signal,
          )) {
            if (ac.signal.aborted) break;
            sendFrame({
              type: useColon ? "stream:data" : "stream.chunk",
              id: frame.id,
              data: chunk,
            });
          }
          if (!ac.signal.aborted) {
            sendFrame({
              type: useColon ? "stream:end" : "stream.end",
              id: frame.id,
            });
          }
        } catch (error) {
          if (!ac.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error);
            sendFrame({
              type: useColon ? "stream:error" : "stream.error",
              id: frame.id,
              error: useColon ? message : { message },
            });
          }
        } finally {
          activeStreams.delete(frame.id);
        }
        return;
      }

      if (frame.type === "stream.close" || frame.type === "stream:close") {
        const ac = activeStreams.get(frame.id);
        if (ac) {
          ac.abort();
          activeStreams.delete(frame.id);
        }
      }
    });

    ws.on("close", () => {
      for (const request of activeRequests.values()) request.abort();
      activeRequests.clear();
      for (const ac of activeStreams.values()) {
        ac.abort();
      }
      activeStreams.clear();
    });
  });
}
