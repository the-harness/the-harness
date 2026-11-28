import { createDescriptor, createRootScope } from "@harness/di";
import { TextBlock, UserMessage } from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import {
  StateSyncClientService,
  type StateSyncClient,
  type StateSyncContract,
  type StateSyncEndpoints,
} from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport } from "@harness/transport";
import { ChatPanel } from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { provideScope } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import {
  SessionsStateSyncContract,
  UiSessionsService,
} from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { ExtensibleVariants } from "@harness/variants";
import { createApp, h } from "vue";
import { LocalSessionCatalog } from "./local-session-catalog.ts";
import "virtual:uno.css";
import "../src/style.css";

let secondId: string;

const localSessions = new LocalSessionCatalog();

class QueueTransport extends Transport {
  constructor(private readonly sessionId?: string) {
    super();
  }

  override async request(path: string, body?: unknown): Promise<unknown> {
    if (localSessions.request(path, body)) return;
    switch (path) {
      case "/rpc/workspace.browseRoot":
        return { root: "/workspace" };
      case "/rpc/chat.listModels":
      case "/rpc/chat.listPresets":
        return [];
      case "/rpc/chat.loadMessages":
        return { messages: [], nextBefore: null, hasMore: false };
      case "/rpc/chat.acknowledgeStatus":
      case "/rpc/state-sync:chat.queue":
        return;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  }

  override async *openStream(path: string): AsyncIterable<unknown> {
    if (path !== "/stream/state-sync:chat.queue") return;
    const label = this.sessionId === secondId ? "Second" : "First";
    const items = [1, 2].map((index) =>
      ExtensibleVariants.serialize(
        UserMessage.create({
          id: `queued-${index}`,
          content: [TextBlock.create({ text: `${label} prompt ${index}` })],
        }),
      ),
    );
    yield { type: "snapshot", snapshot: { rev: 0, items } };
  }

  override childScope(id: string) {
    return createDescriptor(QueueTransport, id);
  }
}

class LocalSessions extends StateSyncClientService {

  override use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T> {
    if (contract.namespace === SessionsStateSyncContract.namespace) {
      return { items: localSessions } as unknown as StateSyncClient<T>;
    }
    return super.use(contract);
  }
}

const scope = createRootScope();
scope.provideAll([
  [Transport, QueueTransport],
  RpcClientService,
  StreamClientService,
  [StateSyncClientService, LocalSessions],
  UiStorageService,
  UiSessionsService,
  UiWorkspaceService,
  UiTabsService,
  UiWorkbenchService,
  UiNotificationService,
  UiChatManagerService,
]);

export function mountChat(): void {
  const sessions = scope.get(UiSessionsService);
  const firstId = sessions.newSession();
  secondId = sessions.newSession();
  sessions.activeId.value = firstId;
  createApp({
    setup() {
      provideScope(scope);
      return () => h(ChatPanel);
    },
  }).mount("#app");
}

export function selectSecondSession(): void {
  scope.get(UiSessionsService).activeId.value = secondId;
}

export function secondQueueReady(): boolean {
  return scope.get(UiChatManagerService).get(secondId).queuedInputs.value.length === 2;
}

export function consumeFirstQueuedMessage(): void {
  const current = scope.get(UiSessionsService).current.value;
  if (current) scope.get(UiChatManagerService).get(current.id).queuedInputs.value.splice(0, 1);
}
