import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachGateway,
  createHarnessRegistry,
  createLoopbackAuthenticator,
  createPasswordAuthHandler,
  createTokenAuthenticator,
  type GatewayAuthenticator,
} from "@harness/gateway";
import { ServerTransport, type RootServerTransport } from "@harness/transport";
import { createServerScope } from "./scope.ts";
import { authorizeGatewayRequest } from "./gateway-authorization.ts";

const distDir = resolve(fileURLToPath(new URL("../client", import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const authPassword = process.env.HARNESS_PASSWORD;
const authToken = process.env.HARNESS_TOKEN;
const passwordAuth = createPasswordAuthHandler({
  password: authPassword,
  authRequired: Boolean(authPassword || authToken),
});

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const scope = createServerScope({
  extensionHostWorkerPath: fileURLToPath(new URL("./extension-host.mjs", import.meta.url)),
});

const registry = createHarnessRegistry();
registry.register({
  meta: {
    harnessId: "local-default",
    name: "Local",
    kind: "local",
  },
  resolveRuntime: async () => scope.get(ServerTransport) as RootServerTransport,
});

const server = createServer(async (req, res) => {
  if (await passwordAuth.handleRequest(req, res)) return;

  const url = new URL(req.url ?? "/", "http://localhost");
  const relPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = join(distDir, relPath);

  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.setHeader("content-type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
    res.end(content);
  } catch {
    try {
      const indexHtml = await readFile(join(distDir, "index.html"));
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(indexHtml);
    } catch {
      res.statusCode = 404;
      res.end("Not Found");
    }
  }
});

const authenticators: GatewayAuthenticator[] = [];
if (authPassword || authToken) {
  authenticators.push(createLoopbackAuthenticator());
  if (authToken) {
    authenticators.push(createTokenAuthenticator({ tokens: [authToken] }));
  }
  if (authPassword) {
    authenticators.push(passwordAuth.authenticator);
  }
}

attachGateway(server, registry, { authenticators, authorizeRequest: authorizeGatewayRequest });

server.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
