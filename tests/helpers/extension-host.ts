import type { Scope } from "../../packages/di/src/index.ts";
import { createHarnessModules } from "./harness-modules.ts";

type DiModule = typeof import("../../packages/di/src/index.ts");
type McpModule = typeof import("../../packages/mcp/src/index.ts");
type ExtensionHostModule = typeof import("../../packages/vscode-ext-host/src/index.ts");

export async function createExtensionHostFixture(path = ":memory:") {
  const modules = await createHarnessModules();
  let scope: Scope | undefined;
  try {
    const [di, mcp, sqlite, extensionHost] = await Promise.all([
      modules.load<DiModule>("/packages/di/src/index.ts"),
      modules.load<McpModule>("/packages/mcp/src/index.ts"),
      modules.load<typeof import("../../packages/sqlite/src/index.ts")>(
        "/packages/sqlite/src/index.ts",
      ),
      modules.load<ExtensionHostModule>("/packages/vscode-ext-host/src/index.ts"),
    ]);
    const rootScope = (scope = di.createRootScope());
    rootScope.provideAll([
      mcp.McpService,
      di.createDescriptor(sqlite.SqliteService, { path }),
      extensionHost.ExtensionHostService,
    ]);
    const service = rootScope.get(extensionHost.ExtensionHostService);
    const mcpService = rootScope.get(mcp.McpService);
    return {
      service,
      scope: rootScope,
      modules,
      async dispose(...sessionIds: string[]) {
        try {
          await Promise.all(sessionIds.map((sessionId) => service.stopSession(sessionId)));
        } finally {
          try {
            await mcpService.dispose();
          } finally {
            rootScope.dispose();
            await modules.close();
          }
        }
      },
    };
  } catch (error) {
    scope?.dispose();
    await modules.close();
    throw error;
  }
}

export async function useFixtureExtensionSecrets({
  modules,
  scope,
  service,
}: Pick<Awaited<ReturnType<typeof createExtensionHostFixture>>, "modules" | "scope" | "service">) {
  const [di, storage, bridge] = await Promise.all([
    modules.load<DiModule>("/packages/di/src/index.ts"),
    modules.load<typeof import("../../packages/secret-storage/src/index.ts")>(
      "/packages/secret-storage/src/index.ts",
    ),
    modules.load<typeof import("../../packages/vscode-ext-host/src/node/secrets.ts")>(
      "/packages/vscode-ext-host/src/node/secrets.ts",
    ),
  ]);
  scope.provideAll([
    di.createDescriptor(storage.SecretStorageService, {
      profileId: "fixture",
      key: new Uint8Array(32),
    }),
  ]);
  scope.setup(() => {
    bridge.useExtensionSecrets(service);
  });
}
