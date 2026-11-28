import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { ExtensionHostService } from "../../packages/vscode-ext-host/src/index.ts";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createMainThreadAuthentication } from "../../packages/vscode-ext-host/src/main-thread/authentication.ts";

const extensionSource = String.raw`
const vscode = require("vscode");
exports.activate = (context) => {
  const authChanges = new vscode.EventEmitter();
  const accounts = [{ id: "a", label: "Account A" }, { id: "b", label: "Account B" }];
  const sessions = [
    { id: "a-read", accessToken: "token-a", account: accounts[0], scopes: ["read"] },
    { id: "a-write", accessToken: "token-write", account: accounts[0], scopes: ["write"] },
    { id: "b-read", accessToken: "token-b", account: accounts[1], scopes: ["read"] },
  ];
  let created = 0;
  const provider = {
    onDidChangeSessions: authChanges.event,
    async getSessions(scopes, options) {
      return sessions.filter(session => (!scopes || scopes.every(scope => session.scopes.includes(scope)))
        && (!options.account || session.account.id === options.account.id));
    },
    async createSession(scopes, options) {
      const session = { id: "created-" + (++created), accessToken: "new-token", account: options.account || accounts[0], scopes };
      sessions.push(session);
      authChanges.fire({ added: [session] });
      return session;
    },
    async removeSession(id) { const index = sessions.findIndex(session => session.id === id); if (index >= 0) sessions.splice(index, 1); },
  };
  const authRegistration = vscode.authentication.registerAuthenticationProvider("fixture", "Fixture", provider, { supportsMultipleAccounts: true });
  context.subscriptions.push(authRegistration, authChanges);
  context.subscriptions.push(vscode.commands.registerCommand("audit.auth", async () => {
    const events = [];
    const event = vscode.authentication.onDidChangeSessions(change => events.push(change.provider));
    const listed = await vscode.authentication.getAccounts("fixture");
    const existing = await vscode.authentication.getSession("fixture", ["read"], { account: accounts[1], silent: true });
    const renewed = await vscode.authentication.getSession("fixture", ["read"], { account: accounts[1], forceNewSession: true });
    let duplicate = false, unknown = false, conflict = false, removed = false;
    try { vscode.authentication.registerAuthenticationProvider("fixture", "Duplicate", provider); } catch { duplicate = true; }
    try { await vscode.authentication.getSession("missing", ["read"], { createIfNone: true }); } catch { unknown = true; }
    try { await vscode.authentication.getSession("fixture", ["read"], { silent: true, forceNewSession: true }); } catch { conflict = true; }
    authRegistration.dispose();
    try { await vscode.authentication.getSession("fixture", ["read"]); } catch { removed = true; }
    authChanges.fire({ changed: sessions });
    event.dispose();
    return { listed, token: existing.accessToken, renewed: renewed.accessToken, created, events, duplicate, unknown, conflict, removed };
  }));

  const mcpChanges = new vscode.EventEmitter();
  const local = new vscode.McpStdioServerDefinition("Local", "server", ["--stdio"], { COUNT: 3, REMOVE: null }, "v1");
  local.cwd = vscode.Uri.file("/project/space dir");
  const remote = new vscode.McpHttpServerDefinition("Remote", vscode.Uri.parse("https://example.test/mcp?api=1"), { Authorization: "Bearer fixture" }, "v2");
  let providedToken = false, resolvedOriginal = false;
  const mcpRegistration = vscode.lm.registerMcpServerDefinitionProvider("fixture.mcp", {
    onDidChangeMcpServerDefinitions: mcpChanges.event,
    provideMcpServerDefinitions(token) {
      providedToken = token.isCancellationRequested === false && typeof token.onCancellationRequested === "function";
      return [local, remote];
    },
    resolveMcpServerDefinition(definition, token) {
      resolvedOriginal = definition === local && !token.isCancellationRequested;
      definition.command = "resolved-server";
      return definition;
    },
  });
  context.subscriptions.push(mcpRegistration, mcpChanges);
  context.subscriptions.push(vscode.commands.registerCommand("audit.mcp", async (operation) => {
    if (operation === "change") { mcpChanges.fire(); await Promise.resolve(); }
    if (operation === "dispose") { mcpRegistration.dispose(); mcpChanges.fire(); await Promise.resolve(); }
    return { providedToken, resolvedOriginal };
  }));
};
`;

async function withExtension<T>(
  run: (host: ExtensionHostService, requests: { method: string; args: unknown[] }[]) => Promise<T>,
): Promise<T> {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "vscode-auth-mcp-"));
  const extensions = join(root, "extensions");
  const directory = join(extensions, "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "auth-mcp",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.auth", "onCommand:audit.mcp"],
    }),
  );
  writeFileSync(join(directory, "extension.cjs"), extensionSource);
  const hostFixture = await createExtensionHostFixture();
  const host = hostFixture.service;
  const requests: { method: string; args: unknown[] }[] = [];
  const quickInput = {
    showQuickPick: async (items: unknown[]) => items[0],
  } as unknown as Parameters<typeof createMainThreadAuthentication>[0];
  const auth = createMainThreadAuthentication(quickInput, {
    executeCommand: (sessionId, command, args) => host.executeCommand(sessionId, command, ...args),
  });
  const unsubscribe = host.onMainThreadCall(async (sessionId, method, args, requestId) => {
    requests.push({ method, args });
    try {
      const result = method.startsWith("auth.") ? await auth(method, args, sessionId) : undefined;
      if (requestId) host.resolveMainCall(requestId, result);
    } catch (error) {
      if (requestId)
        host.resolveMainCall(
          requestId,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
    }
  });
  try {
    await host.scanExtensions(extensions);
    await host.startSession("auth-mcp", [root]);
    return await run(host, requests);
  } finally {
    await hostFixture.dispose("auth-mcp");
    await auth("auth.unregisterSession", [], "auth-mcp");
    unsubscribe();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("VS Code authentication and MCP extension bridges", () => {
  it("uses provider sessions, forwards account options and rejects unsupported sign-ins", async () => {
    await withExtension(async (host) => {
      expect(await host.executeCommand("auth-mcp", "audit.auth")).toEqual({
        listed: [
          { id: "a", label: "Account A" },
          { id: "b", label: "Account B" },
        ],
        token: "token-b",
        renewed: "new-token",
        created: 1,
        events: [{ id: "fixture", label: "Fixture" }],
        duplicate: true,
        unknown: true,
        conflict: true,
        removed: true,
      });
    });
  });

  it("preserves MCP transport fields and invokes provider change and resolution hooks", async () => {
    await withExtension(async (host, requests) => {
      await host.executeCommand("auth-mcp", "audit.mcp", "state");
      expect(await host.executeCommand("auth-mcp", "__mcp.provide.fixture.mcp")).toEqual([
        {
          label: "Local",
          command: "server",
          args: ["--stdio"],
          env: { COUNT: 3, REMOVE: null },
          cwd: "file:///project/space%20dir",
          version: "v1",
        },
        {
          label: "Remote",
          uri: "https://example.test/mcp?api=1",
          headers: { Authorization: "Bearer fixture" },
          version: "v2",
        },
      ]);
      expect(await host.executeCommand("auth-mcp", "__mcp.resolve.fixture.mcp", 0)).toMatchObject({
        command: "resolved-server",
        cwd: "file:///project/space%20dir",
        version: "v1",
      });
      expect(await host.executeCommand("auth-mcp", "audit.mcp", "change")).toEqual({
        providedToken: true,
        resolvedOriginal: true,
      });
      expect(
        requests.filter((request) => request.method === "lm.didChangeMcpProvider"),
      ).toHaveLength(1);
      await host.executeCommand("auth-mcp", "audit.mcp", "dispose");
      expect(
        requests.filter((request) => request.method === "lm.didChangeMcpProvider"),
      ).toHaveLength(1);
      expect(requests.find((request) => request.method === "lm.registerMcpProvider")?.args).toEqual(
        ["fixture.mcp", { canResolve: true }],
      );
    });
  });
});
