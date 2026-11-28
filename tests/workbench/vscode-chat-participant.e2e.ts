import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer } from "vite-plus";
import { createHarnessModules } from "../helpers/harness-modules.ts";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

const extensionSource = String.raw`
const v = require('vscode');
const actions = [];
const statusActions = [];
let chatStatus;
let notice, filtered;
exports.activate = context => {
  const info = { id:'browser-model', name:'Late worker model', family:'fixture', version:'1', maxInputTokens:2048, maxOutputTokens:128, capabilities:{} };
  context.subscriptions.push(v.lm.registerLanguageModelChatProvider('browser-fixture', {
    provideLanguageModelChatInformation: () => [{...info,id:"other-model",name:"Other worker model"},info],
    provideTokenCount: (_model, value) => String(value).length,
    provideLanguageModelChatResponse: (model,messages,_options,progress) => {
      if(model!==info) throw new Error('Model identity lost');
      progress.report(new v.LanguageModelTextPart('worker model received: '));
      progress.report(new v.LanguageModelTextPart(messages[0].content[0].value));
    }
  }));
  context.subscriptions.push(v.chat.createChatParticipant('browser.chat', () => {
    throw new Error('Disabled chat participant was invoked');
  }));
  chatStatus = v.window.createChatStatusItem('browser.status');
  const statusLink = kind => 'command:browser.statusAction?' + encodeURIComponent(JSON.stringify([kind]));
  chatStatus.title = {label:'Fixture status title',link:statusLink('title'),helpText:'Title action tooltip'};
  chatStatus.description = '$(sync~spin) Checking [status action](' + statusLink('description') + ')';
  chatStatus.detail = 'Fixture status detail';
  chatStatus.tooltip = 'Worker status tooltip';
  context.subscriptions.push(chatStatus,
    v.commands.registerCommand('browser.statusAction',kind=>statusActions.push(kind)),
    v.commands.registerCommand('browser.showStatus',()=>chatStatus.show()),
    v.commands.registerCommand('browser.hideStatus',()=>chatStatus.hide()),
    v.commands.registerCommand('browser.updateStatus',()=>{chatStatus.title='Updated status title';chatStatus.description='Updated description';chatStatus.tooltip='Updated tooltip';}),
    v.commands.registerCommand('browser.disposeStatus',()=>chatStatus.dispose()));
  notice = v.chat.createInputNotification('browser.notice');
  notice.message = 'Fixture notification <strong>plain text</strong>';
  notice.description = 'Worker action keeps URI identity';
  notice.actions = [{label:'Apply worker action',commandId:'browser.noticeAction',commandArgs:[v.Uri.file('/notification-fixture.txt')]}];
  notice.autoDismissOnMessage = true;
  notice.sessionTypes = ['local'];
  filtered = v.chat.createInputNotification('browser.filtered');
  filtered.message = 'Remote-only notice'; filtered.sessionTypes = ['remote'];
  context.subscriptions.push(notice, filtered,
    v.commands.registerCommand('browser.noticeAction',uri=>{if(!(uri instanceof v.Uri))throw new Error('URI identity lost');actions.push(uri.fsPath);notice.message='Worker action completed';}),
    v.commands.registerCommand('browser.showNotice',()=>{notice.show();filtered.show();}),
    v.commands.registerCommand('browser.inspect',()=>({actions,statusActions})));

};
`;

test("ChatPanel discovers late worker models and renders extension notifications and status", async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const root = mkdtempSync(join(process.cwd(), "temp/artifacts/chat-participant-browser-"));
  const installed = join(root, "extensions/probe");
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({
      publisher: "fixture",
      name: "browser",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:browser.inspect"],
      contributes: {
        chatParticipants: [
          {
            id: "browser.chat",
            name: "browser",
            fullName: "Late worker participant",
            description: "Explicit local fixture participant",
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
    mcp,
    hostModule,
    digest,
    status,
  ] = await Promise.all([
    modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
    modules.load<typeof import("../../packages/rpc/src/index.ts")>("/packages/rpc/src/index.ts"),
    modules.load<typeof import("../../packages/stream/src/index.ts")>(
      "/packages/stream/src/index.ts",
    ),
    modules.load<typeof import("../../packages/state-sync/src/index.ts")>(
      "/packages/state-sync/src/index.ts",
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
    modules.load<typeof import("../../packages/ui-sessions/src/node.ts")>(
      "/packages/ui-sessions/src/node.ts",
    ),
    modules.load<typeof import("../../packages/ui-workspace/src/node.ts")>(
      "/packages/ui-workspace/src/node.ts",
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
    modules.load<typeof import("../../packages/mcp/src/index.ts")>("/packages/mcp/src/index.ts"),
    modules.load<typeof import("../../packages/vscode-ext-host/src/index.ts")>(
      "/packages/vscode-ext-host/src/index.ts",
    ),
    modules.load<typeof import("../../packages/session-digest/src/node.ts")>(
      "/packages/session-digest/src/node.ts",
    ),
    modules.load<typeof import("../../packages/session-status/src/node.ts")>(
      "/packages/session-status/src/node.ts",
    ),
  ]);
  let hostReady = false;
  let hostSessionId = "";
  const starts: { id: string; roots: readonly string[] }[] = [],
    stops: string[] = [];
  class BrowserExtensionHost extends hostModule.ExtensionHostService {
    override async startSession(
      id: string,
      roots: readonly string[],
      initial: Record<string, unknown> = {},
      signal?: AbortSignal,
    ) {
      await super.startSession(
        id,
        roots,
        { ...initial, storageRoot: join(root, "storage") },
        signal,
      );
      starts.push({ id, roots });
      hostSessionId = id;
      hostReady = true;
    }
  }
  const transport = await modules.load<typeof import("../../packages/transport/src/index.ts")>(
    "/packages/transport/src/index.ts",
  );
  const uiChat = await modules.load<typeof import("../../packages/ui-chat/src/node.ts")>(
    "/packages/ui-chat/src/node.ts",
  );
  const catalogs = await Promise.all([
    modules.load<typeof import("../../packages/session-catalog/src/index.ts")>(
      "/packages/session-catalog/src/index.ts",
    ),
    modules.load<typeof import("../../packages/workspace-catalog/src/index.ts")>(
      "/packages/workspace-catalog/src/index.ts",
    ),
  ]);
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
    catalogs[0].SessionCatalog,
    catalogs[1].WorkspaceCatalog,
    images.ImageStorageService,
    linkedTree.LinkedTree,
    mcp.McpService,
    [hostModule.ExtensionHostService, BrowserExtensionHost],
    workspaces.WorkspaceFsService,
    digest.SessionDigestStore,
    status.SessionStatusHostService,
  ]);
  scope.setup(() => {
    chat.useChatSessions();
    sessionList.useSessionsHandlers();
    uiChat.useChatHandlers();
    hostModule.useExtHostHandlers();
    workspaces.useWorkspaceHandlers();
    status.useSessionStatusHandlers();
  });
  const host = scope.get(hostModule.ExtensionHostService);
  scope.run(() =>
    host.hooks.sessionStopped.use((id, next) => {
      stops.push(id);
      return next();
    }),
  );
  const otherRoot = join(root, "other-workspace");
  mkdirSync(otherRoot);
  scope
    .get(catalogs[1].WorkspaceCatalog)
    .host.items.splice(
      0,
      1,
      { id: "test", name: "test", folders: [root], instructions: "" },
      { id: "other", name: "Other workspace", folders: [otherRoot], instructions: "" },
    );
  const catalog = scope.get(catalogs[0].SessionCatalog);
  for (const { id } of catalog.items) catalog.remove(id);
  for (const [id, workspaceId, title] of [
    ["conversation-c", "other", "Conversation C"],
    ["conversation-b", "test", "Conversation B"],
    ["conversation", "test", "Conversation A"],
  ] as const) {
    catalog.create({ id, workspaceId });
    catalog.rename(id, title);
  }
  const errors: string[] = [];
  const off = host.onMainThreadCall((_session, method) => {
    if (
      ![
        "commands.register",
        "commands.unregister",
        "memento.load",
        "auth.unregisterSession",
        "chatInput.setNotification",
        "chatInput.removeNotification",
        "chatStatus.setItem",
        "chatStatus.removeItem",
      ].includes(method)
    )
      errors.push(method);
  });
  const config = join(root, "vite.config.ts");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(resolve("apps/web/vite.config.ts"))}; export default {...base, plugins: base.plugins.filter(p => !["harness:server-api", "harness:terminal-api"].includes(p?.name))};`,
  );
  const vite = await createServer({
    configFile: config,
    root: resolve("apps/web"),
    cacheDir: join(root, "vite-cache"),
    server: { host: "127.0.0.1", port: 5186, strictPort: true, watch: null },
  });
  gateway.attachGateway(vite.httpServer!, async () => scope.get(transport.ServerTransport) as never);
  const getErrors = await captureBrowserErrors(page);
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  try {
    await vite.listen();
    await page.goto("http://127.0.0.1:5186/tests/vscode-chat-participant.fixture.html");
    await expect(page.getByRole("textbox", { name: "Message Harness" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select model", exact: true })).toHaveText(
      "No model",
    );
    await expect(page.getByRole("button", { name: "Select agent preset" })).toHaveText("No preset");
    await page.evaluate(async () => {
      const fixture = await import("/tests/vscode-chat-participant.fixture.ts");
      await fixture.ready();
      return fixture.snapshot();
    });
    await expect.poll(() => hostReady && starts.at(-1)?.roots[0] === root).toBe(true);
    await host.scanExtensions(join(root, "extensions"));
    await host.executeCommand(hostSessionId, "browser.inspect");
    await expect
      .poll(() => scope.get(llm.LlmService).models.map((model) => model.id))
      .toContain("browser-model");
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    await page.getByRole("menuitem", { name: "Late worker model" }).click();
    const selected = await page.evaluate(async () =>
      (await import("/tests/vscode-chat-participant.fixture.ts")).snapshot(),
    );
    expect(selected).toMatchObject({ model: "browser-model", chatModel: "browser-model" });
    expect(selected.presets).toEqual([]);
    await host.executeCommand(hostSessionId, "browser.showStatus");
    const statusBanner = page.getByRole("status", { name: "Chat extension status" });
    await expect(statusBanner).toHaveCount(1);
    await expect(
      statusBanner.getByRole("button", { name: "Fixture status title" }),
    ).toHaveAttribute("title", "Title action tooltip");
    await expect(statusBanner.locator('.status-text[title="Worker status tooltip"]')).toContainText(
      "Checking status action",
    );
    await expect(statusBanner.locator("svg.status-icon-spin path")).not.toHaveCount(0);
    await expect(statusBanner.locator("svg.status-icon-spin")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(statusBanner.locator("svg.status-icon-spin")).toHaveAttribute(
      "viewBox",
      "0 0 16 16",
    );
    await expect(statusBanner).not.toContainText("$(sync~spin)");
    await expect(statusBanner).toContainText("Fixture status detail");
    await statusBanner.getByRole("button", { name: "Fixture status title" }).click();
    await statusBanner.getByRole("button", { name: "status action", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await host.executeCommand<{ statusActions: string[] }>(hostSessionId, "browser.inspect"))
            .statusActions,
      )
      .toEqual(["title", "description"]);
    await page.screenshot({ path: join(root, "status.png") });
    await host.executeCommand(hostSessionId, "browser.updateStatus");
    await expect(statusBanner).toContainText("Updated status title");
    await expect(statusBanner.locator('.status-text[title="Updated tooltip"]')).toHaveText(
      "Updated description",
    );
    await host.executeCommand(hostSessionId, "browser.hideStatus");
    await expect(statusBanner).toHaveCount(0);
    await host.executeCommand(hostSessionId, "browser.showStatus");
    await expect(statusBanner).toContainText("Updated description");
    await host.executeCommand(hostSessionId, "browser.disposeStatus");
    await expect(statusBanner).toHaveCount(0);
    await host.executeCommand(hostSessionId, "browser.showNotice");
    const banner = page.getByRole("status", { name: "Chat input notification" });
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText("Fixture notification <strong>plain text</strong>");
    await expect(banner.locator("strong")).toHaveCount(0);
    await expect(page.getByText("Remote-only notice", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(root, "notification.png") });
    await banner.getByRole("button", { name: "Apply worker action" }).click();
    await expect(banner).toContainText("Worker action completed");
    await banner.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(banner).toHaveCount(0);
    await host.executeCommand(hostSessionId, "browser.showNotice");
    await expect(banner).toHaveCount(1);
    const firstHostId = hostSessionId,
      startsBefore = starts.length,
      stopsBefore = stops.length;
    await page
      .getByRole("treeitem", { name: "test, has actions", exact: true })
      .locator(".vc-tree-twistie")
      .click();
    await page.getByRole("treeitem", { name: /Conversation B/ }).click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(async () =>
              (await import("/tests/vscode-chat-participant.fixture.ts")).snapshot(),
            )
          ).activeConversation,
      )
      .toBe("conversation-b");
    await page.getByRole("treeitem", { name: /Conversation A/ }).click();
    expect(starts).toHaveLength(startsBefore);
    expect(stops).toHaveLength(stopsBefore);
    await host.executeCommand(firstHostId, "browser.showNotice");
    await expect(banner).toHaveCount(1);

    class FixturePreset extends presets.AgentPreset {
      readonly id = "fixture";
      readonly name = "Fixture Agent";
      setup() {}
    }
    scope.run(() => scope.get(presets.AgentPresetRegistry).usePreset(new FixturePreset()));
    await page.evaluate(async () =>
      (await import("/tests/vscode-chat-participant.fixture.ts")).ready(),
    );
    const composer = page.getByRole("textbox", { name: "Message Harness" });
    await composer.fill("Dismiss on submit");
    await composer.press("Enter");
    await expect(banner).toHaveCount(0);
    await expect(page.getByText("worker model received: Dismiss on submit")).toBeVisible();

    await page
      .getByRole("treeitem", { name: "Other workspace, has actions", exact: true })
      .locator(".vc-tree-twistie")
      .click();
    await page.getByRole("treeitem", { name: /Conversation C/ }).click();
    expect(stops).toHaveLength(stopsBefore);
    await expect.poll(() => starts.at(-1)?.roots).toEqual([otherRoot]);
    await expect(banner).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(async () =>
              (await import("/tests/vscode-chat-participant.fixture.ts")).snapshot(),
            )
          ).commands,
      )
      .not.toContain("browser.inspect");
    await expect(host.executeCommand(firstHostId, "browser.inspect")).resolves.toMatchObject({
      actions: ["/notification-fixture.txt"],
    });
    writeFileSync(join(root, "host-lifecycle.json"), JSON.stringify({ starts, stops }, null, 2));
    await page.screenshot({ path: join(root, "chat.png") });
    writeFileSync(
      join(root, "observed.json"),
      JSON.stringify(
        await page.evaluate(async () =>
          (await import("/tests/vscode-chat-participant.fixture.ts")).snapshot(),
        ),
        null,
        2,
      ),
    );
    expect(warnings).toEqual([]);
    expect(await getErrors()).toEqual([]);
    expect(errors).toEqual([]);
    await page.goto("about:blank");
    await expect.poll(() => [...stops].sort()).toEqual(starts.map(({ id }) => id).sort());
  } catch (error) {
    writeFileSync(
      join(root, "errors.json"),
      JSON.stringify({ errors: await getErrors().catch(() => []), warnings }, null, 2),
    );
    writeFileSync(join(root, "page.html"), await page.content().catch(() => "unavailable"));
    throw error;
  } finally {
    if (hostReady) await host.stopSession(hostSessionId);
    await page
      .evaluate(async () => {
        try {
          (await import("/tests/vscode-chat-participant.fixture.ts")).dispose();
        } catch {}
      })
      .catch(() => {});
    await page.goto("about:blank").catch(() => {});
    off();
    await scope.get(mcp.McpService).dispose();
    await scope.get(sqlite.SqliteService).flush();
    scope.dispose();
    await vite.close();
    await modules.close();
  }
});
