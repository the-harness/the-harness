import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

const extensionSource = String.raw`
const v = require('vscode');
exports.activate = context => {
  const info = {id:'participant-model',name:'Participant model',family:'test',version:'1',maxInputTokens:2048,maxOutputTokens:128,capabilities:{}};
  context.subscriptions.push(v.lm.registerLanguageModelChatProvider('participant-fixture', {
    provideLanguageModelChatInformation: () => [info],
    provideTokenCount: (_model, value) => String(value).length,
    provideLanguageModelChatResponse: (model,messages,options,progress) => {
      if(model!==info) throw new Error('Model provider identity lost');
      progress.report(new v.LanguageModelTextPart('model:' + messages[0].content[0].value));
    }
  }));
  context.subscriptions.push(v.chat.createChatParticipant('fixture.chat', () => {
    throw new Error('Disabled chat participant was invoked');
  }));
};
`;

it(
  "lists extension models without creating presets for disabled Chat participants",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(process.cwd(), "temp/artifacts/chat-consumer-"));
    const installed = join(root, "extensions/probe");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({
        publisher: "fixture",
        name: "chat",
        version: "1.0.0",
        main: "extension.cjs",
        activationEvents: ["onStartup"],
        contributes: {
          chatParticipants: [
            {
              id: "fixture.chat",
              name: "fixture",
              fullName: "Fixture Chat",
              description: "Actual participant",
              commands: [{ name: "explain", description: "Explain" }],
            },
          ],
        },
      }),
    );
    writeFileSync(join(installed, "extension.cjs"), extensionSource);
    const modules = await createHarnessModules();
    const [
      di,
      rpc,
      stream,
      state,
      transport,
      gateway,
      sqlite,
      secretStorage,
      llm,
      providers,
      presets,
      sessions,
      sessionList,
      workspaces,
      images,
      linkedTree,
      chat,
      contract,
      mcp,
      hostModule,
    ] = await Promise.all([
      modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
      modules.load<typeof import("../../packages/rpc/src/index.ts")>("/packages/rpc/src/index.ts"),
      modules.load<typeof import("../../packages/stream/src/index.ts")>(
        "/packages/stream/src/index.ts",
      ),
      modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
        "/packages/state-sync/src/index.ts",
      ),
      modules.load<typeof import("../../packages/transport/src/index.ts")>(
        "/packages/transport/src/index.ts",
      ),
      modules.load<typeof import("../../packages/gateway/src/index.ts")>(
        "/packages/gateway/src/index.ts",
      ),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
      modules.load<typeof import("../../packages/secret-storage/src/index.ts")>(
        "/packages/secret-storage/src/index.ts",
      ),
      modules.load<typeof import("../../packages/llm/src/index.ts")>("/packages/llm/src/index.ts"),
      modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
        "/packages/model-provider/src/index.ts",
      ),
      modules.load<typeof import("../../packages/agent-preset/src/index.ts")>(
        "/packages/agent-preset/src/index.ts",
      ),
      modules.load<typeof import("../../packages/session-manager/src/index.ts")>(
        "/packages/session-manager/src/index.ts",
      ),
      modules.load<typeof import("../../packages/session-catalog/src/index.ts")>(
        "/packages/session-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/workspace-catalog/src/index.ts")>(
        "/packages/workspace-catalog/src/index.ts",
      ),
      modules.load<typeof import("../../packages/image-storage/src/index.ts")>(
        "/packages/image-storage/src/index.ts",
      ),
      modules.load<typeof import("../../packages/linked-tree/src/index.ts")>(
        "/packages/linked-tree/src/index.ts",
      ),
      modules.load<typeof import("../../packages/chat-session/src/index.ts")>(
        "/packages/chat-session/src/index.ts",
      ),
      modules.load<typeof import("../../packages/ui-chat/src/contract.ts")>(
        "/packages/ui-chat/src/contract.ts",
      ),
      modules.load<typeof import("../../packages/mcp/src/index.ts")>("/packages/mcp/src/index.ts"),
      modules.load<typeof import("../../packages/vscode-ext-host/src/index.ts")>(
        "/packages/vscode-ext-host/src/index.ts",
      ),
    ]);
    const uiSessions = await modules.load<typeof import("../../packages/ui-sessions/src/node.ts")>(
      "/packages/ui-sessions/src/node.ts",
    );
    const uiChat = await modules.load<typeof import("../../packages/ui-chat/src/node.ts")>(
      "/packages/ui-chat/src/node.ts",
    );
    const scope = di.createRootScope();
    scope.provideAll([
      [transport.ServerTransport, transport.RootServerTransport],
      rpc.RpcServerService,
      stream.StreamServerService,
      state.StateSyncServerService,
      di.createDescriptor(sqlite.SqliteService, { path: join(root, "chat.db") }),
      di.createDescriptor(secretStorage.SecretStorageService, { profileId: "fixture" }),
      llm.LlmService,
      providers.ProviderManager,
      presets.AgentPresetRegistry,
      sessions.SessionManager,
      sessionList.SessionCatalog,
      workspaces.WorkspaceCatalog,
      images.ImageStorageService,
      linkedTree.LinkedTree,
      mcp.McpService,
      hostModule.ExtensionHostService,
    ]);
    scope.setup(() => {
      chat.useChatSessions();
      uiSessions.useSessionsHandlers();
      uiChat.useChatHandlers();
      hostModule.useExtHostHandlers();
    });
    const host = scope.get(hostModule.ExtensionHostService);
    const sessionManager = scope.get(sessions.SessionManager);
    scope
      .get(workspaces.WorkspaceCatalog)
      .host.items.splice(0, 1, { id: "test", name: "test", folders: [root], instructions: "" });
    const catalog = scope.get(sessionList.SessionCatalog);
    catalog.create({ id: "conversation", workspaceId: "test" });
    catalog.rename("conversation", "Chat");
    const errors: string[] = [];
    const off = host.onMainThreadCall((_session, method, _args, requestId) => {
      let value: unknown;
      if (["commands.register", "commands.unregister", "auth.unregisterSession"].includes(method))
        value = undefined;
      else if (method === "memento.load") value = {};
      else {
        errors.push(method);
        host.resolveMainCall(requestId!, undefined, `Unexpected main call: ${method}`);
        return;
      }
      host.resolveMainCall(requestId!, value);
    });
    const server = createServer();
    gateway.attachGateway(server, async () => scope.get(transport.ServerTransport) as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubGlobal("location", {
      protocol: "http:",
      host: `127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const client = di.createRootScope();
    client.provideAll([
      transport.WebTransportConnection,
      [
        transport.Transport,
        di.createDescriptor(transport.WebTransport, ["conversation"]),
      ],
      rpc.RpcClientService,
    ]);
    const api = client.run(() => client.get(rpc.RpcClientService).use(contract.ChatRpcContract));
    try {
      await host.scanExtensions(join(root, "extensions"));
      await host.startSession("runtime", [root], { storageRoot: join(root, "storage") });
      await host.activateByEvent("runtime", "onStartup");
      await vi.waitFor(async () =>
        expect((await api.listModels()).some((model) => model.id === "participant-model")).toBe(
          true,
        ),
      );
      expect(await api.listPresets()).toEqual([]);
      sessionManager.acquire("conversation").get(chat.ChatSession);
      expect(sessionManager.get("conversation")).toBeDefined();
      catalog.remove("conversation");
      await vi.waitFor(() => expect(sessionManager.get("conversation")).toBeUndefined());
      expect(errors).toEqual([]);
    } finally {
      await host.stopSession("runtime");
      off();
      client.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
      await scope.get(mcp.McpService).dispose();
      await scope.get(sqlite.SqliteService).flush();
      scope.dispose();
      await modules.close();
    }
  },
);
