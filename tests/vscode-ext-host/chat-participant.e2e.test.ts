import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";
import { createMainThreadAuthentication } from "../../packages/vscode-ext-host/src/main-thread/authentication.ts";

const source = String.raw`
const vscode = require("vscode");
let notification, notificationUri, status;
exports.activate = context => {
  context.subscriptions.push(vscode.chat.onDidDisposeChatSession(() => {}));
  const warnings = [];
  const warn = console.warn;
  let participant;
  console.warn = message => { warnings.push(message); warn(message); };
  try {
    participant = vscode.chat.createChatParticipant("audit.participant", () => {
      throw new Error("Disabled chat participant was invoked");
    });
  } finally {
    console.warn = warn;
  }
  participant.followupProvider = { provideFollowups() { return []; } };
  context.subscriptions.push(participant, participant.onDidReceiveFeedback(() => {}), participant.onDidPerformAction(() => {}));
  context.subscriptions.push(vscode.commands.registerCommand("audit.configure", (model, uri) => ({ model, same: uri === notificationUri, uri: uri instanceof vscode.Uri })));
  context.subscriptions.push(vscode.commands.registerCommand("audit.chat", async operation => {
    if (operation === "warnings") return warnings;
    if (operation === "status") {
      status = vscode.window.createChatStatusItem("workspace-index");
      status.title = { label: "Workspace index", link: "https://example.invalid/index", helpText: "Index details" };
      status.description = "$(sync) Indexing"; status.detail = "[Details](https://example.invalid/help)"; status.tooltip = "Index status";
      status.show(); status.description = "$(check) Ready"; await vscode.commands.getCommands(); return status.id;
    }
    if (operation === "hide-status") { status.hide(); await vscode.commands.getCommands(); return; }
    if (operation === "dispose-status") { status.dispose(); await vscode.commands.getCommands(); try { status.show(); } catch (error) { return error.message; } }
    if (operation === "notification") {
      notification = vscode.chat.createInputNotification("model-configuration");
      notification.severity = vscode.ChatInputNotificationSeverity.Warning;
      notification.message = "Configure a model";
      notification.description = "A real configuration action";
      notificationUri = vscode.Uri.file("/workspace/model.json");
      notification.actions = [{ label: "Configure", commandId: "audit.configure", commandArgs: ["model", notificationUri] }];
      notification.show(); notification.message = "Updated model configuration";
      await vscode.commands.getCommands(); return notification.id;
    }
    if (operation === "hide-notification") { notification.hide(); await vscode.commands.getCommands(); return; }
    if (operation === "auto-notification") { notification.dismissible = false; notification.autoDismissOnMessage = true; notification.show(); await vscode.commands.getCommands(); return; }
    if (operation === "dispose-notification") {
      notification.dispose(); await vscode.commands.getCommands();
      try { notification.show(); } catch (error) { return error.message; }
    }
    if (operation === "dispose") participant.dispose();
    if (operation === "values") {
      const msg = vscode.LanguageModelChatMessage2.User("text", "user");
      msg.content2 = ["second", new vscode.LanguageModelToolResultPart("call", [new vscode.LanguageModelTextPart("ok")], true)];
      const data = vscode.LanguageModelDataPart.json({ ok: true });
      const limited = vscode.LanguageModelError.RateLimited("retry", 3);
      const trusted = new vscode.MarkdownString("unsafe"); trusted.isTrusted = true;
      let rejected = false; try { new vscode.ChatResponseMarkdownPart(trusted); } catch { rejected = true; }
      return { role: msg.role, text: msg.content[0].value, error: msg.content[1].isError, content2: msg.content2[0],
        mime: data.mimeType, json: new TextDecoder().decode(data.data), code: limited.code, retry: limited.retryAfter, rejected };
    }
  }));
};
`;

it("warns and keeps chat participants inert while forwarding Chat notifications and status", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "chat-participant-"));
  const extension = join(root, "extension");
  mkdirSync(extension);
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "chat",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.chat"],
      contributes: {
        chatParticipants: [
          {
            id: "audit.participant",
            name: "audit",
            commands: [{ name: "explain", description: "Explain" }],
          },
        ],
      },
    }),
  );
  writeFileSync(join(extension, "extension.cjs"), source);
  const fixture = await createExtensionHostFixture();
  const host = fixture.service;
  const participantCalls: string[] = [];
  const notifications = new Map<string, unknown>();
  const statuses = new Map<string, unknown>();
  const off = host.onMainThreadCall(async (_session, method, args, requestId) => {
    try {
      const data = args[0] as any;
      if (method.startsWith("chat.")) participantCalls.push(method);
      else if (method === "chatInput.setNotification") notifications.set(data.id, data);
      else if (method === "chatInput.removeNotification") notifications.delete(data);
      else if (method === "chatStatus.setItem") statuses.set(data.id, data);
      else if (method === "chatStatus.removeItem") statuses.delete(data);
      if (requestId) host.resolveMainCall(requestId, undefined);
    } catch (error) {
      if (requestId) host.resolveMainCall(requestId, undefined, String(error));
    }
  });
  try {
    await host.scanExtensions(root);
    await host.startSession("host-runtime", [root]);
    expect(await host.executeCommand("host-runtime", "audit.chat", "warnings")).toEqual([
      'vscode.chat.createChatParticipant("audit.participant") is disabled in Harness.',
    ]);
    expect(await host.executeCommand("host-runtime", "audit.chat", "status")).toBe(
      "workspace-index",
    );
    expect([...statuses.values()]).toEqual([
      {
        id: "chat-status-1",
        title: {
          label: "Workspace index",
          link: "https://example.invalid/index",
          helpText: "Index details",
        },
        description: "$(check) Ready",
        detail: "[Details](https://example.invalid/help)",
        tooltip: "Index status",
      },
    ]);
    await host.executeCommand("host-runtime", "audit.chat", "hide-status");
    expect(statuses.size).toBe(0);
    expect(await host.executeCommand("host-runtime", "audit.chat", "dispose-status")).toBe(
      "Chat status item is disposed",
    );
    expect(await host.executeCommand("host-runtime", "audit.chat", "notification")).toBe(
      "model-configuration",
    );
    expect([...notifications.values()]).toMatchObject([
      {
        id: "chat-input-1",
        severity: 1,
        message: "Updated model configuration",
        description: "A real configuration action",
        actions: [
          {
            label: "Configure",
            commandId: "audit.configure",
            commandArgs: ["model", { scheme: "file", path: "/workspace/model.json" }],
          },
        ],
        dismissible: true,
        autoDismissOnMessage: false,
      },
    ]);
    expect(
      await host.executeCommand("host-runtime", "__chatInput.invokeAction", "chat-input-1", 0),
    ).toEqual({ model: "model", same: true, uri: true });
    await host.executeCommand("host-runtime", "audit.chat", "hide-notification");
    expect(notifications.size).toBe(0);
    await host.executeCommand("host-runtime", "audit.chat", "auto-notification");
    expect(await host.executeCommand("host-runtime", "__chatInput.dismiss", "chat-input-1")).toBe(
      false,
    );
    expect(
      await host.executeCommand("host-runtime", "__chatInput.dismiss", "chat-input-1", "message"),
    ).toBe(true);
    expect(await host.executeCommand("host-runtime", "audit.chat", "dispose-notification")).toBe(
      "Chat input notification is disposed",
    );
    expect(await host.executeCommand("host-runtime", "audit.chat", "values")).toEqual({
      role: 1,
      text: "second",
      error: true,
      content2: "second",
      mime: "text/x-json",
      json: '{\n\t"ok": true\n}',
      code: "RateLimited",
      retry: 3,
      rejected: true,
    });
    await host.executeCommand("host-runtime", "audit.chat", "dispose");
    await host.stopSession("host-runtime");
    expect(participantCalls).toEqual([]);
  } finally {
    await fixture.dispose("host-runtime");
    off();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("waits for one implicitly activated authentication provider across concurrent account requests", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "chat-auth-activation-"));
  const provider = join(root, "provider"),
    caller = join(root, "caller");
  mkdirSync(provider);
  mkdirSync(caller);
  writeFileSync(
    join(provider, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "delayed-auth",
      version: "1.0.0",
      main: "extension.cjs",
      contributes: { authentication: [{ id: "delayed", label: "Delayed" }] },
    }),
  );
  writeFileSync(
    join(provider, "extension.cjs"),
    `
    const vscode = require("vscode");
    exports.activate = async context => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const emitter = new vscode.EventEmitter();
      context.subscriptions.push(vscode.authentication.registerAuthenticationProvider("delayed", "Delayed", {
        onDidChangeSessions: emitter.event,
        getSessions: async () => [{ id: "session", accessToken: "fixture", account: { id: "account", label: "Account" }, scopes: [] }],
        createSession: async () => { throw new Error("No login allowed"); }, removeSession: async () => {},
      }));
    };
  `,
  );
  writeFileSync(
    join(caller, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "auth-caller",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.concurrentAccounts"],
    }),
  );
  writeFileSync(
    join(caller, "extension.cjs"),
    `
    const vscode = require("vscode");
    exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand("audit.concurrentAccounts", () =>
      Promise.all([vscode.authentication.getAccounts("delayed"), vscode.authentication.getAccounts("delayed")])
    ));
  `,
  );
  const fixture = await createExtensionHostFixture(),
    host = fixture.service;
  const auth = createMainThreadAuthentication({} as never, {
    executeCommand: (session, command, args) => host.executeCommand(session, command, ...args),
  });
  let registrations = 0;
  const off = host.onMainThreadCall(async (session, method, args, requestId) => {
    try {
      if (method === "auth.registerProvider") registrations++;
      const result = method.startsWith("auth.") ? await auth(method, args, session) : undefined;
      if (requestId) host.resolveMainCall(requestId, result);
    } catch (error) {
      if (requestId) host.resolveMainCall(requestId, undefined, String(error));
    }
  });
  try {
    await host.scanExtensions(root);
    await host.startSession("auth-runtime", [root]);
    expect(await host.executeCommand("auth-runtime", "audit.concurrentAccounts")).toEqual([
      [{ id: "account", label: "Account" }],
      [{ id: "account", label: "Account" }],
    ]);
    expect(registrations).toBe(1);
  } finally {
    await fixture.dispose("auth-runtime");
    off();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
