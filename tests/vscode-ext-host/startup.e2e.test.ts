import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createHarnessModules } from "../helpers/harness-modules.ts";

it("initializes configured extensions once across concurrent contribution reads and real worker starts", async () => {
  const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "extension-startup-"));
  const extensions = join(root, "extensions");
  const initial = join(extensions, "configured");
  mkdirSync(initial, { recursive: true });
  writeFileSync(
    join(initial, "package.json"),
    JSON.stringify({
      publisher: "audit",
      name: "configured",
      version: "1.0.0",
      main: "extension.cjs",
      activationEvents: ["onCommand:audit.startup"],
    }),
  );
  writeFileSync(
    join(initial, "extension.cjs"),
    `
    const vscode = require("vscode");
    exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand("audit.startup", () => vscode.extensions.all.map(extension => extension.id)));
  `,
  );
  const modules = await createHarnessModules();
  const [di, mcp, sqlite, extensionsModule] = await Promise.all([
    modules.load<typeof import("../../packages/di/src/index.ts")>("/packages/di/src/index.ts"),
    modules.load<typeof import("../../packages/mcp/src/index.ts")>("/packages/mcp/src/index.ts"),
    modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
      "/packages/sqlite/src/index.ts",
    ),
    modules.load<typeof import("../../packages/vscode-ext-host/src/index.ts")>(
      "/packages/vscode-ext-host/src/index.ts",
    ),
  ]);
  const scope = di.createRootScope();
  scope.provideAll([
    mcp.McpService,
    di.createDescriptor(sqlite.SqliteService, { path: ":memory:" }),
    di.createDescriptor(extensionsModule.ExtensionHostService, { extensionsDir: extensions }),
  ]);
  const host = scope.get(extensionsModule.ExtensionHostService);
  const stop = host.onMainThreadCall(async (_session, _method, _args, requestId) => {
    if (requestId) host.resolveMainCall(requestId, {});
  });
  try {
    const [first, second] = await Promise.all([
      host.getContributions(),
      host.getContributions(),
      host.startSession("first", [root]),
    ]);
    expect(first.map((snapshot) => snapshot.id)).toEqual(["audit.configured"]);
    expect(second.map((snapshot) => snapshot.id)).toEqual(["audit.configured"]);
    expect(await host.executeCommand("first", "audit.startup")).toEqual(["audit.configured"]);

    const late = join(extensions, "late");
    mkdirSync(late);
    writeFileSync(
      join(late, "package.json"),
      JSON.stringify({ publisher: "audit", name: "late", version: "1.0.0" }),
    );
    const [later] = await Promise.all([
      host.getContributions(),
      host.startSession("second", [root]),
    ]);
    expect(later.map((snapshot) => snapshot.id)).toEqual(["audit.configured"]);
    expect(await host.executeCommand("second", "audit.startup")).toEqual(["audit.configured"]);
    await host.scanExtensions(extensions);
    const rescanned = await host.getContributions();
    expect(rescanned.map((snapshot) => snapshot.id).sort()).toEqual([
      "audit.configured",
      "audit.late",
    ]);
    writeFileSync(
      join(root, "report.json"),
      JSON.stringify(
        {
          initial: first.map((snapshot) => snapshot.id),
          later: later.map((snapshot) => snapshot.id),
          rescanned: rescanned.map((snapshot) => snapshot.id),
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([host.stopSession("first"), host.stopSession("second")]);
    stop();
    await scope.get(mcp.McpService).dispose();
    scope.dispose();
    await modules.close();
  }
}, 20_000);
