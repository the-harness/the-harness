import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createExtensionHostFixture } from "../helpers/extension-host.ts";

it("runs extension logging, telemetry opt-in and scoped persistent terminal environments across worker restarts", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "runtime-services-"));
  const extension = join(root, "extension");
  mkdirSync(extension);
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "runtime",
      version: "1.0.0",
      main: "./extension",
      activationEvents: ["*"],
      contributes: {
        configuration: {
          properties: { "runtime.contributed": { type: "string", default: "from-manifest" } },
        },
        configurationDefaults: { "[typescript]": { "runtime.contributed": "typescript-default" } },
      },
    }),
  );
  writeFileSync(
    join(extension, "extension.js"),
    String.raw`
    const v = require("vscode"), fs = require("node:fs"), path = require("node:path");
    exports.activate = context => {
      const log = v.window.createOutputChannel("Runtime", { log: true });
      const levels = [], events = [], telemetryChanges = [], metered = [];
      context.subscriptions.push(v.env.onDidChangeMeteredConnection(value => metered.push(value)));
      context.subscriptions.push(log, log.onDidChangeLogLevel(level => levels.push(level)));
      const telemetry = v.env.createTelemetryLogger({ sendEventData: (name, data) => events.push({ name, data }), sendErrorData: error => events.push({ error: error.message }), flush: () => events.push({ flushed: true }) });
      context.subscriptions.push(telemetry, telemetry.onDidChangeEnableStates(logger => telemetryChanges.push([logger.isUsageEnabled, logger.isErrorsEnabled])));
      context.subscriptions.push(v.commands.registerCommand("runtime.inspect", () => ({ levels, events, telemetryChanges, metered, isMetered: v.env.isMeteredConnection, logLevel: log.logLevel, contributed: v.workspace.getConfiguration("runtime").get("contributed"), env: [...context.environmentVariableCollection], paths: [context.globalStorageUri.fsPath, context.storageUri.fsPath, context.logUri.fsPath] })));
      context.subscriptions.push(v.commands.registerCommand("runtime.log", () => {
        log.debug("debug message"); log.info("info %s", "message"); log.error(new Error("error message"));
        telemetry.logUsage("usage"); telemetry.logError(new Error("telemetry error"));
        return v.l10n.t({ message: "Hello {name}: {count}", args: { name: "world", count: 3 }, comment: "test" });
      }));
      context.subscriptions.push(v.commands.registerCommand("runtime.environment", () => {
        const env = context.environmentVariableCollection;
        env.replace("HARNESS_TEST_ENV", "base");
        env.getScoped({ workspaceFolder: v.workspace.workspaceFolders[0] }).append("HARNESS_TEST_ENV", ":scoped");
        const visited = []; env.forEach((name, value, collection) => visited.push([name, value.type, collection === env]));
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        fs.writeFileSync(path.join(context.globalStorageUri.fsPath, "marker"), "persisted");
        return visited;
      }));
      context.subscriptions.push(v.commands.registerCommand("runtime.setPeerVariable", () => {
        context.environmentVariableCollection.replace("HARNESS_PEER_ENV", "peer");
      }));
      context.subscriptions.push(v.commands.registerCommand("runtime.languageConfig", () => {
        const config = v.workspace.getConfiguration("runtime", { languageId: "typescript" });
        return { value: config.get("contributed"), inspect: config.inspect("contributed") };
      }));
    };
  `,
  );
  const fixture = await createExtensionHostFixture();
  const logs: string[] = [];
  const errors: string[] = [];
  const off = fixture.service.onMainThreadCall(async (_session, method, args, requestId) => {
    let result: unknown;
    if (method === "memento.load") result = {};
    else if (method === "output.appendLine") logs.push(String(args[1]));
    else if (
      ![
        "commands.register",
        "commands.unregister",
        "output.create",
        "output.dispose",
        "auth.unregisterSession",
      ].includes(method)
    )
      errors.push(method);
    if (requestId) fixture.service.resolveMainCall(requestId, result);
  });
  const start = (session = "runtime") =>
    fixture.service.startSession(session, [root], { storageRoot: join(root, "data") });
  const command = <T = unknown>(name: string, ...args: unknown[]) =>
    fixture.service.executeCommand<T>("runtime", name, ...args);
  try {
    await fixture.service.scanExtensions(root);
    await start();
    expect(await command("runtime.log")).toBe("Hello world: 3");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("[info] info message");
    expect(logs[1]).toContain("Error: error message");
    expect(await command("runtime.inspect")).toMatchObject({
      logLevel: 3,
      events: [],
      contributed: "from-manifest",
    });
    expect(await command("runtime.languageConfig")).toMatchObject({
      value: "typescript-default",
      inspect: { defaultValue: "from-manifest", defaultLanguageValue: "typescript-default" },
    });
    await command("__env.sync", { logLevel: 2, isTelemetryEnabled: true, telemetryLevel: "all" });
    await command("runtime.log");
    expect(logs).toHaveLength(5);
    expect(await command("runtime.inspect")).toMatchObject({
      levels: [2],
      logLevel: 2,
      events: [{ name: "usage" }, { error: "telemetry error" }],
      telemetryChanges: [[true, true]],
    });
    await command("__env.sync", { isMeteredConnection: true });
    await command("__env.sync", { isMeteredConnection: true });
    expect(await command("runtime.inspect")).toMatchObject({ metered: [true], isMetered: true });
    await start("peer");
    expect(await fixture.service.executeCommand("peer", "runtime.inspect")).toMatchObject({
      env: [],
    });
    expect(await command("runtime.environment")).toEqual([["HARNESS_TEST_ENV", 1, true]]);
    const state = await command<{ paths: string[] }>("runtime.inspect");
    expect(state.paths.every((path) => path.startsWith(join(root, "data")))).toBe(true);
    expect(readFileSync(join(state.paths[0]!, "marker"), "utf8")).toBe("persisted");
    await fixture.service.stopSession("runtime");
    await fixture.service.executeCommand("peer", "runtime.setPeerVariable");
    await fixture.service.stopSession("peer");
    await start();
    expect(await command("runtime.inspect")).toMatchObject({
      env: [
        ["HARNESS_TEST_ENV", { type: 1, value: "base" }],
        ["HARNESS_PEER_ENV", { type: 1, value: "peer" }],
      ],
    });
    expect(errors).toEqual([]);
  } finally {
    await fixture.dispose("runtime", "peer");
    off();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
