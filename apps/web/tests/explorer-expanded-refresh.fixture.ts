import { createRootScope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import {
  StateSyncClientService,
  type StateSyncClient,
  type StateSyncContract,
  type StateSyncEndpoints,
} from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { UiConfigService } from "@harness/ui-config";
import { provideScope } from "@harness/ui-di";
import { FileEditorService } from "@harness/ui-editor";
import { FilePickerHost, UiFilePickerService } from "@harness/ui-file-picker";
import { UiNotificationService } from "@harness/ui-notifications";
import { SessionsStateSyncContract, UiSessionsService } from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import {
  FilesPanel,
  UiWorkspaceService,
  WorkspaceStateSyncContract,
  type Workspace,
} from "@harness/ui-workspace";
import { createApp, Fragment, h, shallowReactive } from "vue";
import "virtual:uno.css";
import "../src/style.css";

class ExplorerTransport extends WebTransport {
  override async *openStream(path: string, body?: unknown, signal?: AbortSignal) {
    if (path !== "/stream/workspace.watchRoots") {
      yield* super.openStream(path, body, signal);
    } else if (signal && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

class ExplorerCatalogs extends StateSyncClientService {
  private readonly workspaces = { items: shallowReactive<Workspace[]>([]) };

  override use<T extends StateSyncEndpoints>(contract: StateSyncContract<T>): StateSyncClient<T> {
    if (contract.namespace === SessionsStateSyncContract.namespace) {
      return { items: { items: [] } } as unknown as StateSyncClient<T>;
    }
    if (contract.namespace === WorkspaceStateSyncContract.namespace) {
      return { items: this.workspaces } as unknown as StateSyncClient<T>;
    }
    throw new Error(`Unexpected catalog: ${contract.namespace}`);
  }
}

const scope = createRootScope();
scope.provideAll([
  WebTransportConnection,
  [Transport, ExplorerTransport],
  RpcClientService,
  StreamClientService,
  [StateSyncClientService, ExplorerCatalogs],
  UiStorageService,
  UiSessionsService,
  UiWorkspaceService,
  UiFilePickerService,
  UiTabsService,
  UiWorkbenchService,
  UiConfigService,
  FileEditorService,
  UiNotificationService,
]);

export async function mountExplorer(root: string): Promise<void> {
  const workspace = scope.get(UiWorkspaceService);
  await workspace.getRoot(root).loadDir();
  workspace.createWorkspace({ folders: [root] });
  mountFilesPanel();
}

export function mountFilesPicker(): void {
  mountFilesPanel(true);
}

function mountFilesPanel(withPicker = false): void {
  createApp({
    setup() {
      provideScope(scope);
      return () => (withPicker ? h(Fragment, [h(FilesPanel), h(FilePickerHost)]) : h(FilesPanel));
    },
  }).mount("#app");
}
