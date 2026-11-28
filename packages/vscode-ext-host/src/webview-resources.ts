import type { IncomingMessage, ServerResponse } from "node:http";
import { Uri } from "@harness/vscode-types";
import type { ExtensionHostService } from "./service.ts";

export async function serveWebviewResource(
  host: Pick<ExtensionHostService, "executeCommand">,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const match = /^\/([^/]+)\/([^/]+)\/file(\/.*)$/.exec(pathname);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const result = await host.executeCommand<{ body: string; mime: string }>(
      decodeURIComponent(match[1]!),
      `__webview.resource.${decodeURIComponent(match[2]!)}`,
      Uri.file(decodeURIComponent(match[3]!)).toJSON(),
    );
    response.writeHead(200, {
      "content-type": result.mime,
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(Buffer.from(result.body, "base64"));
  } catch {
    response.writeHead(404).end();
  }
}
