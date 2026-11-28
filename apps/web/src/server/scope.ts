import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentPresetRegistry } from "@harness/agent-preset";
import { useChatSessions } from "@harness/chat-session";
import { useCodexCodingAgentPreset } from "@harness/codex-coding-agent";
import { useDeepSeekProvider } from "@harness/deepseek";
import { createDescriptor, createRootScope, defineSetup, inject, useServices } from "@harness/di";
import { ImageStorageService, useImageHandlers } from "@harness/image-storage";
import { LinkedTree } from "@harness/linked-tree";
import { LlmProvider, LlmService } from "@harness/llm";
import { McpService } from "@harness/mcp";
import { ScriptedMockLlmProvider } from "@harness/mock-llm";
import { ProviderManager } from "@harness/model-provider";
import { usePiCodingAgentPreset } from "@harness/pi-coding-agent";
import { RpcServerService } from "@harness/rpc";
import { SecretStorageService } from "@harness/secret-storage";
import { SessionCatalog } from "@harness/session-catalog";
import { SessionTitleService } from "@harness/session-title";
import { SessionManager } from "@harness/session-manager";
import { SqliteService } from "@harness/sqlite";
import { StateSyncServerService } from "@harness/state-sync";
import { SessionDigestStore } from "@harness/session-digest/node";
import {
  recoverSessionStatuses,
  SessionStatusHostService,
  useSessionStatusHandlers,
} from "@harness/session-status/node";
import { StreamServerService } from "@harness/stream";
import { TerminalService } from "@harness/terminal";
import { RootServerTransport, ServerTransport } from "@harness/transport";
import { useChatHandlers } from "@harness/ui-chat/node";
import { useFilePickerHandlers } from "@harness/ui-file-picker/node";
import { useSessionsHandlers } from "@harness/ui-sessions/node";
import { useWorkspaceHandlers, WorkspaceFsService } from "@harness/ui-workspace/node";
import { ExtensionHostService, useExtHostHandlers } from "@harness/vscode-ext-host";
import { WorkspaceCatalog } from "@harness/workspace-catalog";
import { onScopeDispose } from "reactivity";

export interface ServerOptions {
  readonly extensionHostWorkerPath?: string;
}

export function createServerScope(options: ServerOptions = {}) {
  const scope = createRootScope({ id: "web-server" });
  try {
    // Production watchers can report an initial route error without propagating it.
    let registering = true;
    let failure: { error: unknown } | undefined;
    scope.setup(() => {
      try {
        useServer(options);
      } catch (error) {
        if (registering) failure = { error };
        throw error;
      }
    });
    registering = false;
    if (failure) throw failure.error;
    scope.run(() => recoverSessionStatuses());
  } catch (error) {
    try {
      scope.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Web runtime startup and cleanup failed");
    }
    throw error;
  }
  return scope;
}

export function useServer(options: ServerOptions = {}): void {
  const dbPath = process.env["HARNESS_CHAT_DB"] ?? ".harness/chat.db";
  if (dbPath === "") {
    throw new Error("HARNESS_CHAT_DB must specify a database path when set.");
  }
  const secretKeyFile = process.env["HARNESS_SECRET_STORAGE_KEY_FILE"];
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  useServices([
    [ServerTransport, RootServerTransport],
    RpcServerService,
    StreamServerService,
    StateSyncServerService,
    createDescriptor(SqliteService, { path: dbPath }),
    createDescriptor(SecretStorageService, {
      profileId: "default",
      ...(secretKeyFile ? { key: readFileSync(secretKeyFile) } : {}),
    }),
    ImageStorageService,
    WorkspaceFsService,
    WorkspaceCatalog,
    SessionCatalog,
    SessionTitleService,
    LinkedTree,
    ProviderManager,
    LlmService,
    AgentPresetRegistry,
    SessionManager,
    SessionDigestStore,
    SessionStatusHostService,
    McpService,
    createDescriptor(ExtensionHostService, { workerPath: options.extensionHostWorkerPath }),
    TerminalService,
  ]);

  useChatSessions();
  useProviders();
  useHandlers();
}

const useProviders = defineSetup(() => {
  // Browser e2e tests run against a model that answers once and then holds the run until it is stopped.
  if (process.env["HARNESS_MOCK_LLM"] === "1") {
    const provider = inject(ProviderManager).create({ id: "mock" });
    onScopeDispose(() => provider.dispose());
    provider.provide(
      LlmProvider,
      createDescriptor(ScriptedMockLlmProvider, async (ctx) => {
        ctx.text(`Processed: **${ctx.lastUserText || "Request"}**`);
        await ctx.flush();
        await ctx.waitForAbort();
      }),
    );
    return;
  }
  useDeepSeekProvider({
    baseUrl: process.env["DEEPSEEK_BASE_URL"],
    apiKey: process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["DEEPSEEK_API_KEY"],
  });
});

const useHandlers = defineSetup(() => {
  usePiCodingAgentPreset();
  useCodexCodingAgentPreset();
  useWorkspaceHandlers();
  useFilePickerHandlers();
  useSessionsHandlers();
  useSessionStatusHandlers();
  useChatHandlers();
  useExtHostHandlers();
  useImageHandlers();
});
