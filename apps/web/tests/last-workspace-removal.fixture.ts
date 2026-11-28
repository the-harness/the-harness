import { createDescriptor, createRootScope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { UiSessionStatusService } from "@harness/session-status";
import {
  StateSyncClientService,
  type StateSyncClient,
  type StateSyncContract,
  type StateSyncEndpoints,
} from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport } from "@harness/transport";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { provideScope } from "@harness/ui-di";
import {
  SessionsPanel,
  SessionsStateSyncContract,
  UiSessionsService,
} from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  UiWorkspaceService,
  WorkspaceStateSyncContract,
  type Workspace,
} from "@harness/ui-workspace";
import { createApp, h, shallowReactive } from "vue";
import { LocalSessionCatalog } from "./local-session-catalog.ts";
import "virtual:uno.css";
import "../src/style.css";

const localSessions = new LocalSessionCatalog();

class LocalTransport extends Transport {
  override async request(path: string, body?: unknown): Promise<unknown> {
    if (localSessions.request(path, body)) return;
    switch (path) {
      case "/rpc/workspace.browseRoot":
        return { root: "/workspace" };
      case "/rpc/workspace.readDir":
        return { entries: [], truncated: false };
      case "/rpc/chat.listModels":
      case "/rpc/chat.listPresets":
        return [];
      case "/rpc/chat.acknowledgeStatus":
      case "/rpc/chat.abortRun":
        return undefined;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  }

  override async *openStream(): AsyncIterable<unknown> {}

  override childScope() {
    return createDescriptor(LocalTransport);
  }
}

class LocalCatalogs extends StateSyncClientService {
  private readonly workspaces = { items: shallowReactive<Workspace[]>([]) };

  override use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T> {
    if (contract.namespace === SessionsStateSyncContract.namespace) {
      return { items: localSessions } as unknown as StateSyncClient<T>;
    }
    if (contract.namespace === WorkspaceStateSyncContract.namespace) {
      return { items: this.workspaces } as unknown as StateSyncClient<T>;
    }
    return super.use(contract);
  }
}

const scope = createRootScope();
scope.provideAll([
  [Transport, LocalTransport],
  RpcClientService,
  StreamClientService,
  [StateSyncClientService, LocalCatalogs],
  UiStorageService,
  UiWorkspaceService,
  UiSessionsService,
  UiSessionStatusService,
  UiChatManagerService,
  UiTabsService,
  UiWorkbenchService,
]);

export function mountConversations(): void {
  const workspace = scope.get(UiWorkspaceService).createWorkspace({
    name: "Only workspace",
    folders: ["/workspace"],
  });
  const sessions = scope.get(UiSessionsService);
  sessions.renameSession(sessions.newSession(workspace.id), "Bound conversation");

  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "width:320px;height:500px";
  createApp({
    setup() {
      provideScope(scope);
      return () => h(SessionsPanel);
    },
  }).mount(container);
}

export function readState() {
  const workspace = scope.get(UiWorkspaceService);
  const sessions = scope.get(UiSessionsService);
  return {
    activeWorkspace: workspace.activeWorkspaceId.value,
    activeSession: sessions.activeId.value,
    workspaceCount: workspace.workspaces.value.length,
    sessionCount: sessions.sessions.value.length,
  };
}
