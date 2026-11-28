import { createRootScope } from "@harness/di";
import {
  FileEditorService,
  FileEditorTabDescriptor,
  FileEditorView,
  openFileEditorTab,
} from "@harness/ui-editor";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { UiConfigService } from "@harness/ui-config";
import { provideScope } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { PanelHost, UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import {
  DockviewVue,
  themeDark,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-vue";
import { createApp, h } from "vue";
import "dockview-vue/dist/styles/dockview.css";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([
  WebTransportConnection,
  [Transport, WebTransport],
  RpcClientService,
  StateSyncClientService,
  StreamClientService,
  UiConfigService,
  UiNotificationService,
  UiSessionsService,
  UiStorageService,
  UiTabsService,
  UiWorkbenchService,
  UiWorkspaceService,
  FileEditorService,
]);
const tabs = scope.get(UiTabsService);
const editor = scope.get(FileEditorService);
scope.run(() =>
  tabs.useRenderer({ descriptor: FileEditorTabDescriptor, component: FileEditorView }),
);

const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
createApp({
  setup() {
    provideScope(scope);
    return () =>
      h(
        DockviewVue,
        {
          theme: themeDark,
          style: { height: "100%" },
          onReady: ({ api }: DockviewReadyEvent) => {
            scope.get(UiWorkbenchService).attach(api);
            markReady();
          },
        },
        { "panel-extension": (params: IDockviewPanelProps) => h(PanelHost, { params }) },
      );
  },
}).mount("#app");

export async function openFile(root: string): Promise<void> {
  await ready;
  await openFileEditorTab(tabs, editor, { root, relativePath: "sample.txt" });
}

export function reloadFile(root: string): Promise<void> {
  return editor.reloadDocument(`${root}/sample.txt`);
}
