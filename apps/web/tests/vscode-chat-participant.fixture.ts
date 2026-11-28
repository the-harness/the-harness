import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { RpcClientService } from "@harness/rpc";
import { StreamClientService } from "@harness/stream";
import { StateSyncClientService } from "@harness/state-sync";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { UiStorageService } from "@harness/ui-storage";
import { UiSessionStatusService } from "@harness/session-status";
import { SessionsPanel, UiSessionsService } from "@harness/ui-sessions";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { UiCommandsService } from "@harness/ui-commands";
import { UiConfigService } from "@harness/ui-config";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiOutputService } from "@harness/ui-output";
import { UiQuickInputService } from "@harness/ui-quick-input";
import { UiStatusBarService } from "@harness/ui-status-bar";
import { UiTerminalService } from "@harness/ui-terminal";
import { UiWebviewService } from "@harness/ui-webview";
import { FileEditorService } from "@harness/ui-editor";
import {
  VscodeEnvCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { useExtHostWorkbench } from "@harness/vscode-ext-host/workbench";
import { ChatPanel } from "@harness/ui-chat";
import { createApp, h } from "vue";
import "virtual:uno.css";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([
  UiStorageService,
  UiNotificationService,
  UiTabsService,
  UiWorkbenchService,
  WebTransportConnection,
  [Transport, WebTransport],
  RpcClientService,
  StreamClientService,
  StateSyncClientService,
  UiSessionStatusService,
  UiSessionsService,
  UiWorkspaceService,
  UiChatManagerService,
  UiCommandsService,
  UiConfigService,
  UiOutputService,
  UiQuickInputService,
  UiFilePickerService,
  UiStatusBarService,
  UiTerminalService,
  UiWebviewService,
  FileEditorService,
  VscodeEnvCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
  ExtensionHostClientService,
]);
scope.get(UiSessionsService).activeId.value = "conversation";
scope.setup(() => useExtHostWorkbench());
const app = createApp({
  setup() {
    provideScope(scope);
    return () =>
      h("div", { style: "display:flex;width:1200px;height:800px" }, [
        h(SessionsPanel, { style: "width:260px;flex:none" }),
        h(ChatPanel, { style: "flex:1;min-width:0" }),
      ]);
  },
});
app.mount("#app");
export async function ready() {
  const manager = scope.get(UiChatManagerService);
  await Promise.all([manager.refreshModels(), manager.get("conversation").refreshChoices()]);
}
export function snapshot(sessionId = "conversation") {
  const manager = scope.get(UiChatManagerService);
  const chat = manager.get(sessionId);
  return {
    activeConversation: scope.get(UiSessionsService).current.value?.id,
    roots: scope.get(UiWorkspaceService).activeRoots.value,
    commands: scope.get(UiCommandsService).commands.value.map((command) => command.id),
    notifications: [...scope.get(ExtensionHostClientService).chatInputNotifications.values()],
    models: manager.models.value,
    chatModels: chat.models.value,
    presets: chat.presets.value,
    model: manager.model.value,
    chatModel: chat.model.value,
    preset: chat.preset.value,
    messages: chat.messages.value,
    running: manager.isRunning(sessionId),
  };
}
export function execute(command: string) {
  return scope.get(UiCommandsService).execute(command);
}
export function dispose() {
  app.unmount();
  scope.dispose();
}
