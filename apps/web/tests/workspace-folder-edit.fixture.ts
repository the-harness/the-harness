import { createRootScope } from "@harness/di";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { provideScope } from "@harness/ui-di";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiWorkspaceService, WorkspacePanel } from "@harness/ui-workspace";
import { createApp, h } from "vue";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([
  WebTransportConnection,
  [Transport, WebTransport],
  RpcClientService,
  StateSyncClientService,
  StreamClientService,
  UiFilePickerService,
  UiSessionsService,
  UiStorageService,
  UiWorkspaceService,
]);
const workspace = scope.get(UiWorkspaceService);

createApp({
  setup() {
    provideScope(scope);
    return () => h(WorkspacePanel);
  },
}).mount("#app");

export function createWorkspace(folders: readonly string[]): string {
  return workspace.createWorkspace({ name: "Workspace folder editing", folders }).id;
}

export function selectWorkspace(id: string): void {
  workspace.activeWorkspaceId.value = id;
}

export function workspaceFolders(id: string): readonly string[] | undefined {
  return workspace.getWorkspace(id)?.folders;
}

export function removeWorkspace(id: string): void {
  if (workspace.activeWorkspaceId.value === id) workspace.activeWorkspaceId.value = "";
  workspace.removeWorkspace(id);
}
