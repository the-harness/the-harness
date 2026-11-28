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
import { ChatPanel, type ChatMessagesPage } from "@harness/ui-chat";
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

function deferredHistory(label: string) {
  return {
    label,
    sessionId: "",
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
}

const first = deferredHistory("First");
const second = deferredHistory("Second");

function historyPage(label: string, older: boolean): ChatMessagesPage {
  const text = `${label} ${older ? "older" : "latest"} prompt`;
  return {
    messages: [
      ExtensibleVariants.serialize(
        UserMessage.create({ id: text, content: [TextBlock.create({ text })] }),
      ),
    ],
    nextBefore: older ? null : 1,
    hasMore: !older,
  };
}

const localSessions = new LocalSessionCatalog();

class HistoryTransport extends Transport {
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
      case "/rpc/chat.acknowledgeStatus":
        return;
      case "/rpc/chat.loadMessages": {
        const history = [first, second].find((entry) => entry.sessionId === this.sessionId);
        if (!history) throw new Error("No history for this session");
        const older = typeof (body as { before?: number }).before === "number";
        if (older) {
          history.started.resolve();
          await history.release.promise;
        }
        return historyPage(history.label, older);
      }
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  }

  override async *openStream(): AsyncIterable<unknown> {}

  override childScope(id: string) {
    return createDescriptor(HistoryTransport, id);
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
  [Transport, HistoryTransport],
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
  for (const history of [first, second]) {
    history.sessionId = sessions.newSession();
    sessions.renameSession(history.sessionId, `${history.label} conversation`);
  }
  sessions.activeId.value = first.sessionId;
  createApp({
    setup() {
      provideScope(scope);
      return () => h(ChatPanel);
    },
  }).mount("#app");
}

export async function switchWhileLoading(): Promise<void> {
  await first.started.promise;
  scope.get(UiSessionsService).activeId.value = second.sessionId;
}

export async function finishFirstWhileSecondLoads(): Promise<void> {
  await second.started.promise;
  first.release.resolve();
}

export function firstHistoryLoaded(): boolean {
  const chat = scope.get(UiChatManagerService).get(first.sessionId);
  return chat.messages.value.some((message) => message.text === "First older prompt");
}

export function finishSecond(): void {
  second.release.resolve();
}
