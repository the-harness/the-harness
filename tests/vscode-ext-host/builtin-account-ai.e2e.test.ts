import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createBuiltinLanguageHost } from "../helpers/builtin-languages.ts";
import { useFixtureExtensionSecrets } from "../helpers/extension-host.ts";
import { createMainThreadAuthentication } from "../../packages/vscode-ext-host/src/main-thread/authentication.ts";
import { createMainThreadChatInputNotifications } from "../../packages/vscode-ext-host/src/main-thread/chat-input.ts";
import { createMainThreadChatStatus } from "../../packages/vscode-ext-host/src/main-thread/chat-status.ts";
import { createMainThreadCommands } from "../../packages/vscode-ext-host/src/main-thread/commands.ts";

const builtins =
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR ??
  process.env.HARNESS_VSCODE_BUILTINS_DIR ??
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));

const source = String.raw`
const vscode = require("vscode");
exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand("audit.offlineBuiltin", async (extensionId, operation) => {
  if (!globalThis.__HARNESS_OFFLINE_PROBE__ && (!process.permission || process.permission.has("net"))) throw new Error("Offline process must deny network");
  const extension = vscode.extensions.getExtension(extensionId);
  const api = await extension.activate();
  if (operation === "github" || operation === "microsoft") {
    const accounts = await vscode.authentication.getAccounts(operation);
    const session = await vscode.authentication.getSession(operation, [operation === "github" ? "read:user" : "User.Read"], { silent: true });
    return { active: extension.isActive, accounts, session, networkAllowed: globalThis.__HARNESS_OFFLINE_PROBE__ ? false : process.permission.has("net") };
  }
  if (operation === "github-remotes") {
    const gitBase = vscode.extensions.getExtension("vscode.git-base").exports.getAPI(1);
    const actions = await gitBase.getRemoteSourceActions("https://github.com/microsoft/vscode.git");
    for (const action of actions) await action.run("main");
    return { active: extension.isActive, networkAllowed: process.permission.has("net"), actions: actions.map(action => ({ label: action.label, icon: action.icon })) };
  }
  if (operation === "jsts") return { active: extension.isActive, treatment: await api.experimentationService.getTreatmentVariable("harness-offline-missing", "fallback"), networkAllowed: globalThis.__HARNESS_OFFLINE_PROBE__ ? false : process.permission.has("net"), skills: extension.packageJSON.contributes.chatSkills };
  return { active: extension.isActive, apiKeys: Object.keys(api ?? {}), tools: vscode.lm.tools.map(tool => tool.name), commands: await vscode.commands.getCommands(true), networkAllowed: globalThis.__HARNESS_OFFLINE_PROBE__ ? false : process.permission.has("net") };
}));
`;

const cases = [
  { directory: "github", id: "vscode.github", operation: "github-remotes" },
  { directory: "github-authentication", id: "vscode.github-authentication", operation: "github" },
  {
    directory: "microsoft-authentication",
    id: "vscode.microsoft-authentication",
    operation: "microsoft",
  },
  {
    directory: "TypeScriptTeam.jsts-chat-features",
    id: "TypeScriptTeam.jsts-chat-features",
    operation: "jsts",
  },
  { directory: "copilot", id: "GitHub.copilot-chat", operation: "copilot" },
];

for (const { directory, id, operation } of cases) {
  it.skipIf(
    !existsSync(join(builtins, directory, "package.json")) ||
      (operation === "copilot" && process.env.HARNESS_RUN_BLOCKED_COPILOT !== "1"),
  )(
    `runs installed ${id} with isolated accounts and no network`,
    async () => {
      mkdirSync(artifacts, { recursive: true });
      const root = mkdtempSync(join(artifacts, `builtin-${directory}-`));
      const workspaceRoot = operation === "copilot" ? join(root, "project") : root;
      if (workspaceRoot !== root) {
        mkdirSync(workspaceRoot);
        writeFileSync(join(workspaceRoot, "example.ts"), "export const answer = 42;\n");
      }
      const extensions = join(root, "extensions");
      mkdirSync(extensions);
      for (const name of operation === "github-remotes"
        ? ["github", "git-base"]
        : operation === "copilot"
          ? ["copilot", "github-authentication", "microsoft-authentication"]
          : [directory]) {
        const installed = join(builtins, name),
          mounted = join(extensions, name);
        mkdirSync(mounted);
        for (const entry of readdirSync(installed))
          symlinkSync(join(installed, entry), join(mounted, entry));
      }
      const audit = join(extensions, "audit");
      mkdirSync(audit);
      writeFileSync(
        join(audit, "package.json"),
        JSON.stringify({
          publisher: "audit",
          name: "offline-builtin",
          version: "1.0.0",
          main: "extension.cjs",
          activationEvents: ["onCommand:audit.offlineBuiltin"],
        }),
      );
      writeFileSync(join(audit, "extension.cjs"), source);
      const requests: { method: string; args: unknown[] }[] = [];
      const externalUrls: string[] = [];
      const runtimeErrors: string[] = [];
      let uiScope: { run<T>(fn: () => T): T | undefined; stop(): void } | undefined;
      let handleConfiguration:
        | ((session: string, method: string, args: unknown[]) => Promise<unknown>)
        | undefined;
      let handleComments:
        | ((session: string, method: string, args: unknown[]) => Promise<boolean>)
        | undefined;
      const workspaceMethods = new Set([
        "workspace.getConfig",
        "workspace.updateConfig",
        "workspace.findTextInFiles",
        "workspace.readFile",
        "workspace.readFileBytes",
        "workspace.readDirectory",
        "workspace.openTextDocument",
      ]);
      let inputNotifications: ReturnType<typeof createMainThreadChatInputNotifications>;
      const chatStatus = createMainThreadChatStatus();
      let mainCommands: ReturnType<typeof createMainThreadCommands>;
      let auth: ReturnType<typeof createMainThreadAuthentication>;
      const fixture = await createBuiltinLanguageHost(
        root,
        async (session, method, args) => {
          if (
            method === "output.appendLine" &&
            /(?:\[error\].*(?:TypeError|Error:|Failed to read ignore)|ConversationFeature: failed to query language models)/.test(
              String(args[1]),
            )
          )
            runtimeErrors.push(String(args[1]));
          if (inputNotifications?.handle(session, method, args)) return { handled: true };
          if (chatStatus.handle(session, method, args)) return { handled: true };
          if (
            method.startsWith("comments.") &&
            handleComments &&
            (await handleComments(session, method, args))
          )
            return { handled: true };
          if (method === "commands.execute" && operation === "copilot")
            return {
              handled: true,
              result: await mainCommands.execute(String(args[0]), args.slice(1)),
            };
          if (workspaceMethods.has(method) && handleConfiguration)
            return { handled: true, result: await handleConfiguration(session, method, args) };
          if (method.startsWith("auth.")) {
            requests.push({
              method,
              args,
            });
            return { handled: true, result: await auth(method, args, session) };
          }
          if (method === "window.registerUriHandler" || method === "window.unregisterUriHandler")
            return { handled: true };
          if (method === "env.openExternal" && operation === "github-remotes") {
            externalUrls.push(String(args[0]));
            return { handled: true, result: false };
          }
          if (method === "env.openExternal")
            throw new Error("Offline probe must not open an external browser");
          return { handled: false };
        },
        join(root, "chat.sqlite"),
      );
      inputNotifications = createMainThreadChatInputNotifications((session, command, args) =>
        fixture.host.executeCommand(session, command, ...args),
      );
      mainCommands = createMainThreadCommands({
        has: (command) => fixture.commands.has(command),
        execute: (command, ...args) => fixture.host.executeCommand(operation, command, ...args),
      });
      auth = createMainThreadAuthentication(
        {
          showQuickPick: () => {
            throw new Error("Silent account lookup must not prompt");
          },
        } as never,
        {
          executeCommand: (session, command, args) =>
            fixture.host.executeCommand(session, command, ...args),
        },
      );
      let disposeChatModels: (() => Promise<void>) | undefined;
      let closeModelServer: (() => Promise<void>) | undefined;
      const modelRequests: unknown[] = [];
      try {
        await useFixtureExtensionSecrets({
          ...fixture,
          service: fixture.host,
        });
        if (operation === "copilot") {
          const vue = createRequire(
            new URL("../../packages/ui-storage/package.json", import.meta.url),
          )("vue") as { effectScope(detached: boolean): NonNullable<typeof uiScope> };
          uiScope = vue.effectScope(true);
          const [
            di,
            llm,
            providers,
            presets,
            sessions,
            sessionsHost,
            sqlite,
            modelsModule,
            configModule,
            storageModule,
            workspaceModule,
            deepseek,
            workspaces,
            images,
            linkedTree,
            commentsModule,
          ] = await Promise.all([
            fixture.modules.load<typeof import("../../packages/di/src/index.ts")>(
              "/packages/di/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/llm/src/index.ts")>(
              "/packages/llm/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/model-provider/src/index.ts")>(
              "/packages/model-provider/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/agent-preset/src/index.ts")>(
              "/packages/agent-preset/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/session-manager/src/index.ts")>(
              "/packages/session-manager/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/session-catalog/src/index.ts")>(
              "/packages/session-catalog/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
              "/packages/sqlite/src/index.ts",
            ),
            fixture.modules.load<
              typeof import("../../packages/vscode-ext-host/src/main-thread/language-models.ts")
            >("/packages/vscode-ext-host/src/main-thread/language-models.ts"),
            fixture.modules.load<typeof import("../../packages/ui-config/src/index.ts")>(
              "/packages/ui-config/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/ui-storage/src/index.ts")>(
              "/packages/ui-storage/src/index.ts",
            ),
            fixture.modules.load<
              typeof import("../../packages/vscode-ext-host/src/main-thread/workspace.ts")
            >("/packages/vscode-ext-host/src/main-thread/workspace.ts"),
            fixture.modules.load<typeof import("../../packages/deepseek/src/llm.ts")>(
              "/packages/deepseek/src/llm.ts",
            ),
            fixture.modules.load<typeof import("../../packages/ui-workspace/src/node.ts")>(
              "/packages/ui-workspace/src/node.ts",
            ),
            fixture.modules.load<typeof import("../../packages/image-storage/src/index.ts")>(
              "/packages/image-storage/src/index.ts",
            ),
            fixture.modules.load<typeof import("../../packages/linked-tree/src/index.ts")>(
              "/packages/linked-tree/src/index.ts",
            ),
            fixture.modules.load<
              typeof import("../../packages/vscode-ext-host/src/main-thread/comments.ts")
            >("/packages/vscode-ext-host/src/main-thread/comments.ts"),
          ]);
          const workspaceCatalog = await fixture.modules.load<
            typeof import("../../packages/workspace-catalog/src/index.ts")
          >("/packages/workspace-catalog/src/index.ts");
          uiScope.run(() =>
            fixture.scope.provideAll([
              providers.ProviderManager,
              llm.LlmService,
              presets.AgentPresetRegistry,
              sessions.SessionManager,
              sessionsHost.SessionCatalog,
              storageModule.UiStorageService,
              configModule.UiConfigService,
              workspaceCatalog.WorkspaceCatalog,
              workspaces.WorkspaceFsService,
              images.ImageStorageService,
              linkedTree.LinkedTree,
            ]),
          );
          const server = createServer(async (request, response) => {
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const body = JSON.parse(Buffer.concat(chunks).toString());
              modelRequests.push({ url: request.url, body });
              writeFileSync(
                join(root, "local-model-requests.json"),
                JSON.stringify(modelRequests, null, 2),
              );
              response.setHeader("content-type", "text/event-stream");
              const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
              emit({ type: "message_start", message: { usage: { input_tokens: 3 } } });
              emit({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              });
              emit({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Local deterministic model response." },
              });
              emit({ type: "content_block_stop", index: 0 });
              emit({
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 5 },
              });
              emit({ type: "message_stop" });
              response.end();
            } catch (error) {
              response.writeHead(500);
              response.end(String(error));
            }
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          closeModelServer = () =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            });
          const providerScope = fixture.scope
            .get(providers.ProviderManager)
            .create({ id: "local-http-fixture" });
          providerScope.provide(
            llm.LlmProvider,
            di.createDescriptor(deepseek.DeepSeekLlmProvider, {
              baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
              preferFilesApi: false,
              models: [
                {
                  id: "local-fixture-model",
                  name: "Local deterministic HTTP model",
                  contextWindow: 128000,
                  maxTokens: 4096,
                  inputModalities: [llm.TextModality.create({})],
                },
              ],
            }),
          );
          writeFileSync(
            join(root, "local-model-fixture.json"),
            JSON.stringify(
              {
                provider: "production DeepSeekLlmProvider",
                model: "local-fixture-model",
                endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                response: "Local deterministic model response.",
                cloudInference: false,
              },
              null,
              2,
            ),
          );
          const config = uiScope.run(() => fixture.scope.get(configModule.UiConfigService))!;
          for (const [key, value] of Object.entries({
            "telemetry.telemetryLevel": "off",
            "microsoft-authentication.implementation": "msal-no-broker",
            "jsts-chat-features.skills.enabled": true,
          }))
            config.set(key, value, "user");
          const filesystem = fixture.scope.get(workspaces.WorkspaceFsService);
          const configuration = workspaceModule.createMainThreadWorkspace(
            {
              activeRoots: { value: [workspaceRoot] },
              getRoot: () => ({
                readFile: (path: string) => filesystem.readFile(workspaceRoot, path),
                loadDir: (path: string) => filesystem.readDir(workspaceRoot, path, true),
              }),
            } as never,
            config,
          );
          handleConfiguration = async (session, method, args) => {
            const value = await configuration(method, args);
            if (method === "workspace.updateConfig") {
              await fixture.host.executeCommand(session, "__config.sync", config.snapshot());
              writeFileSync(
                join(root, "configuration.json"),
                JSON.stringify(config.snapshot(), null, 2),
              );
            }
            return value;
          };
          const models = fixture.scope.run(() =>
            modelsModule.createMainThreadLanguageModels(
              fixture.scope.get(llm.LlmService),
              fixture.scope.get(providers.ProviderManager),
              fixture.host,
            ),
          );
          const comments = uiScope.run(() =>
            fixture.scope.run(() =>
              commentsModule.createMainThreadComments(
                {
                  visibleTextEditors: { value: [] },
                  createTextEditorDecorationType(options: unknown) {
                    const key = "headless-comments";
                    fixture.decorationTypes.set(key, options);
                    return {
                      key,
                      dispose() {
                        fixture.decorationTypes.delete(key);
                      },
                    };
                  },
                  showTextDocument() {
                    throw new Error(
                      "The offline Chat fixture has no editor surface; comment reveal requires the browser scenario",
                    );
                  },
                } as never,
                (session, command, args) => fixture.host.executeCommand(session, command, ...args),
                () => {
                  throw new Error("The offline Chat fixture has no comments panel");
                },
                mainCommands.contexts,
              ),
            ),
          )!;
          handleComments = (session, method, args) => comments.handle(session, method, args);
          const stopRouter = fixture.host.registerMainThreadRouter((session, method, args) =>
            models.handle(session, method, args),
          );
          const lifecycle = fixture.scope.createChild();
          lifecycle.run(() =>
            fixture.host.hooks.sessionStopped.use((session, next) => {
              void models
                .clearSession(session, true)
                .catch((error) => runtimeErrors.push(String(error)));
              inputNotifications.clearSession(session);
              chatStatus.clearSession(session);
              comments.clearSession(session);
              return next();
            }),
          );
          disposeChatModels = async () => {
            stopRouter();
            lifecycle.dispose();
            comments.dispose();
            await models.dispose();
            await fixture.scope.get(sqlite.SqliteService).flush();
          };
        }
        await fixture.host.scanExtensions(extensions);
        const previous = process.env.NODE_OPTIONS;
        process.env.NODE_OPTIONS =
          operation === "copilot"
            ? `${previous ?? ""} --require=${fileURLToPath(new URL("../helpers/offline-builtin.cjs", import.meta.url))}`
            : `${previous ?? ""} --permission --allow-fs-read=* --allow-fs-write=*`;
        const previousNetworkLog = process.env.HARNESS_OFFLINE_NETWORK_LOG;
        process.env.HARNESS_OFFLINE_NETWORK_LOG = join(root, "blocked-network.jsonl");
        try {
          await fixture.host.startSession(operation, [workspaceRoot], {
            storageRoot: join(root, "storage"),
            configuration: {
              defaults: {},
              user: {
                "telemetry.telemetryLevel": "off",
                "microsoft-authentication.implementation": "msal-no-broker",
                "jsts-chat-features.skills.enabled": true,
              },
              workspace: {},
            },
            environment: { isTelemetryEnabled: false, telemetryLevel: "off" },
            windowState: { focused: true, active: true },
            tabGroups: { groups: [{ id: "main", isActive: true, viewColumn: 1, tabs: [] }] },
          });
        } finally {
          if (previous === undefined) delete process.env.NODE_OPTIONS;
          else process.env.NODE_OPTIONS = previous;
          if (previousNetworkLog === undefined) delete process.env.HARNESS_OFFLINE_NETWORK_LOG;
          else process.env.HARNESS_OFFLINE_NETWORK_LOG = previousNetworkLog;
        }
        let activationTimeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          fixture.host.executeCommand<Record<string, unknown>>(
            operation,
            "audit.offlineBuiltin",
            id,
            operation,
          ),
          new Promise<never>((_, reject) => {
            activationTimeout = setTimeout(
              () =>
                reject(new Error("Official builtin activation did not finish within 20 seconds")),
              20_000,
            );
          }),
        ]).finally(() => clearTimeout(activationTimeout));
        writeFileSync(
          join(root, "result.json"),
          JSON.stringify(
            {
              id,
              result,
              requests,
              externalUrls,
              runtimeErrors,
              modelRequestCount: modelRequests.length,
              notifications: [...inputNotifications.notifications.values()],
            },
            null,
            2,
          ) + "\n",
        );
        expect(result.networkAllowed).toBe(false);
        expect(result.active).toBe(true);
        if (operation === "github" || operation === "microsoft") {
          expect(result.accounts).toEqual([]);
          expect(result.session).toBeUndefined();
          expect(
            requests.some(
              (request) =>
                request.method === "auth.registerProvider" && request.args[0] === operation,
            ),
          ).toBe(true);
        } else if (operation === "github-remotes") {
          expect(result.actions).toEqual([
            { label: "Open on GitHub", icon: "github" },
            { label: "Checkout on vscode.dev", icon: "globe" },
          ]);
          expect(externalUrls).toEqual([
            "https://github.com/microsoft/vscode/tree/main",
            "https://vscode.dev/github/microsoft/vscode/tree/main",
          ]);
        } else if (operation === "jsts") expect(result.treatment).toBe("fallback");
        else expect((result.tools as string[]).length).toBeGreaterThan(0);
        expect(fixture.errors).toEqual([]);
      } catch (error) {
        writeFileSync(
          join(root, "result.json"),
          JSON.stringify(
            {
              id,
              error: error instanceof Error ? error.stack : String(error),
              requests,
              errors: fixture.errors,
              runtimeErrors,
              modelRequestCount: modelRequests.length,
              notifications: [...inputNotifications.notifications.values()],
            },
            null,
            2,
          ) + "\n",
        );
        throw error;
      } finally {
        try {
          await fixture.host.stopSession(operation);
          await disposeChatModels?.();
        } finally {
          try {
            await fixture.dispose(operation);
          } finally {
            uiScope?.stop();
            await closeModelServer?.();
          }
        }
      }
    },
    40_000,
  );
}
