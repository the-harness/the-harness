import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { DiHmrPlugin } from "../../packages/di/src/vite.ts";
import { defineConfig, type Plugin } from "vite-plus";
import { createServerModuleLoader } from "./server-modules.ts";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { attachGateway } from "@harness/gateway";
import type { RootServerTransport } from "@harness/transport";
import { WebSocketServer } from "ws";
import type * as DevServer from "./src/server/dev.ts";
import type * as TerminalServer from "./src/server/terminal.ts";
import { authorizeGatewayRequest } from "./src/server/gateway-authorization.ts";

async function loadServerScope(loadModule: ReturnType<typeof createServerModuleLoader>) {
  return (await loadModule<typeof DevServer>("/src/server/dev.ts")).scope;
}

// Model access runs in the dev server so the API key never enters the bundle.
function serverApi(): Plugin {
  return {
    name: "harness:server-api",
    apply: "serve",
    configureServer(server) {
      const loadModule = createServerModuleLoader(server);
      const loadScope = () => loadServerScope(loadModule);

      server.middlewares.use("/api/vscode-webview-resource", async (request, response) => {
        const [resolved, { ExtensionHostService, serveWebviewResource }] = await Promise.all([
          loadScope(),
          loadModule<typeof import("@harness/vscode-ext-host")>("@harness/vscode-ext-host"),
        ]);
        await serveWebviewResource(resolved.get(ExtensionHostService), request, response);
      });

      if (server.httpServer) {
        attachGateway(
          server.httpServer,
          async () => {
            const [resolved, { ServerTransport }] = await Promise.all([
              loadScope(),
              loadModule<typeof import("@harness/transport")>("@harness/transport"),
            ]);
            return resolved.get(ServerTransport) as RootServerTransport;
          },
          { authorizeRequest: authorizeGatewayRequest },
        );
      }
    },
  };
}

function terminalApi(): Plugin {
  return {
    name: "harness:terminal-api",
    apply: "serve",
    configureServer(server) {
      const loadModule = createServerModuleLoader(server);
      const loadRuntime = async () => {
        const [scope, mod] = await Promise.all([
          loadServerScope(loadModule),
          loadModule<typeof TerminalServer>("/src/server/terminal.ts"),
        ]);
        return { scope, mod };
      };

      server.middlewares.use("/api/terminals", async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname.replace(/^\/+/, "");

        try {
          const { scope, mod } = await loadRuntime();
          if (req.method === "GET" && pathname === "") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(mod.listTerminals(scope)));
            return;
          }

          if (req.method === "POST" && pathname === "") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
            const info = await mod.createTerminal(scope, {
              cwd: typeof body.cwd === "string" ? body.cwd : undefined,
              cols: typeof body.cols === "number" ? body.cols : undefined,
              rows: typeof body.rows === "number" ? body.rows : undefined,
              title: typeof body.title === "string" ? body.title : undefined,
              shell: typeof body.shell === "string" ? body.shell : undefined,
              args:
                Array.isArray(body.args) && body.args.every((value) => typeof value === "string")
                  ? body.args
                  : undefined,
              env:
                body.env && typeof body.env === "object" && !Array.isArray(body.env)
                  ? Object.fromEntries(
                      Object.entries(body.env).filter(
                        (entry): entry is [string, string | null] =>
                          typeof entry[1] === "string" || entry[1] === null,
                      ),
                    )
                  : undefined,
            });
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(info));
            return;
          }

          if (req.method === "POST" && pathname.endsWith("/input")) {
            const chunks: Buffer[] = [];
            for await (const chunk of req)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown };
            if (typeof body.data !== "string") {
              res.statusCode = 400;
              res.end("Terminal input must be a string");
              return;
            }
            const written = mod.writeTerminal(scope, decodeURIComponent(pathname.slice(0, -6)), body.data);
            res.statusCode = written ? 204 : 404;
            res.end();
            return;
          }

          if (req.method === "DELETE" && pathname !== "") {
            const id = decodeURIComponent(pathname);
            const killed = mod.killTerminal(scope, id);
            res.statusCode = killed ? 200 : 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: killed }));
            return;
          }

          next();
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      const wss = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = /^\/ws\/terminals\/([^/]+)$/.exec(url.pathname);
        if (!match) return;

        const id = decodeURIComponent(match[1]!);
        wss.handleUpgrade(req, socket, head, async (ws) => {
          try {
            const { scope, mod } = await loadRuntime();
            mod.attachTerminalSocket(scope, ws, id);
          } catch (error) {
            ws.close(1011, error instanceof Error ? error.message : "Internal error");
          }
        });
      });
    },
  };
}

export default defineConfig({
  // The workspace uses legacy TypeScript decorators; Vite's oxc transform does not read
  // experimentalDecorators from tsconfig, so it has to be enabled for the dev transform too.
  oxc: { decorator: { legacy: true } },
  plugins: [
    vue(),
    UnoCSS({ configFile: fileURLToPath(new URL("./uno.config.ts", import.meta.url)) }),
    DiHmrPlugin({
      // Registries that importers rely on stay uninstrumented, so their updates re-run the importers.
      include: (id) =>
        /\.m?ts$/.test(id) &&
        !id.endsWith(".d.ts") &&
        !id.includes("/node_modules/") &&
        !id.includes("/packages/variants/") &&
        (id.includes("/packages/") || id.includes("/apps/web/src/server/")),
    }),
    serverApi(),
    terminalApi(),
  ],
  resolve: {
    alias: {
      reactivity: fileURLToPath(new URL("./src/reactivity.ts", import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ["reactivity", "vue", "@vue/runtime-dom", "@vue/runtime-core", "@vue/reactivity"],
  },
  build: {
    target: "es2024",
  },
});
