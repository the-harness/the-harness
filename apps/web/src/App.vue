<script setup lang="ts">
import { onScopeDispose, watch, watchEffect } from "vue";
import { AuthGate } from "@harness/ui-auth";
import { createRootScope } from "@harness/di";
import { provideScope } from "@harness/ui-di";
import { UiSessionStatusService } from "@harness/session-status";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { UiCommandsService } from "@harness/ui-commands";
import { ConfigStages, createStorageConfigLayer, UiConfigService } from "@harness/ui-config";
import { NotificationCenter, UiNotificationService } from "@harness/ui-notifications";
import { UiOutputService } from "@harness/ui-output";
import { UiQuickInputService } from "@harness/ui-quick-input";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiStatusBarService } from "@harness/ui-status-bar";
import { UiStorageService } from "@harness/ui-storage";
import { UiTerminalService } from "@harness/ui-terminal";
import { UiWebviewService } from "@harness/ui-webview";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { FileEditorService } from "@harness/ui-editor";
import { UiFilePickerService } from "@harness/ui-file-picker";
import { UiWorkspaceService } from "@harness/ui-workspace";
import {
  VscodeCommandsCompatService,
  VscodeEnvCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import {
  activeContributions,
  getContributedFileIconClass,
  getContributedLanguageId,
  getContributedThemeName,
} from "@harness/vscode-editor-compat/contribution-state";
import { ExtensionHostClientService } from "@harness/vscode-ext-host/client";
import { StateSyncClientService } from "@harness/state-sync";
import { RpcClientService } from "@harness/rpc";
import { StreamClientService } from "@harness/stream";
import { Transport } from "@harness/transport";
import { MarkdownHighlighterService } from "@harness/ui-chat";
import { useChatWorkbench } from "@harness/ui-chat/workbench";
import { useOutputWorkbench } from "@harness/ui-output/workbench";
import { useSessionsWorkbench } from "@harness/ui-sessions/workbench";
import { UiScmService } from "@harness/ui-scm";
import { useScmWorkbench } from "@harness/ui-scm/workbench";
import { useWorkspaceWorkbench } from "@harness/ui-workspace/workbench";
import { useTerminalWorkbench } from "@harness/ui-terminal/workbench";
import { WorkbenchShell } from "@harness/ui-workbench-shell";
import { useExtHostWorkbench } from "@harness/vscode-ext-host/workbench";
import { WebTransport, WebTransportConnection } from "@harness/transport";

const rootScope = createRootScope({ id: "web" });
rootScope.provideAll([
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
  UiChatManagerService,
  MarkdownHighlighterService,
  UiCommandsService,
  UiConfigService,
  UiStatusBarService,
  UiQuickInputService,
  UiOutputService,
  FileEditorService,
  UiFilePickerService,
  UiWorkspaceService,
  VscodeWorkspaceCompatService,
  VscodeLanguagesCompatService,
  VscodeWindowCompatService,
  VscodeCommandsCompatService,
  VscodeEnvCompatService,
  UiTerminalService,
  UiScmService,
  UiWebviewService,
  ExtensionHostClientService,
]);
provideScope(rootScope);
rootScope.setup(() => {
  rootScope
    .get(UiConfigService)
    .useLayer(
      createStorageConfigLayer(
        rootScope.get(UiStorageService),
        ["config", "workspace"],
        "core:ui-config-workspace",
      ),
      ConfigStages.Workspace,
    );
  useChatWorkbench();
  useSessionsWorkbench();
  useWorkspaceWorkbench();
  useOutputWorkbench();
  useTerminalWorkbench();
  useScmWorkbench();
  useExtHostWorkbench();
});
rootScope.run(() => {
  const workbench = rootScope.get(UiWorkbenchService);
  const editor = rootScope.get(FileEditorService);
  workbench.registerFileIconResolver(getContributedFileIconClass);
  editor.registerLanguageResolver(getContributedLanguageId);
  watch(
    activeContributions,
    () => {
      workbench.setThemeName(getContributedThemeName());
      editor.refreshLanguages();
    },
    { immediate: true },
  );
});
onScopeDispose(() => rootScope.dispose());

const sessions = rootScope.get(UiSessionsService);
const workbench = rootScope.get(UiWorkbenchService);
watchEffect(() => {
  const title = sessions.current.value?.title.trim();
  document.title = title ? `${title} — Harness` : "Harness — Agent Workbench";
});
watchEffect(() => {
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", workbench.theme.value === "light" ? "#fafafd" : "#191a1b");
});
</script>

<template>
  <AuthGate>
    <WorkbenchShell />
    <NotificationCenter />
  </AuthGate>
</template>
