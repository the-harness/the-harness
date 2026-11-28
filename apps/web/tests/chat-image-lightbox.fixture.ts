import { createRootScope } from "@harness/di";
import { ImageRpcContract } from "@harness/image-storage/contract";
import { ImageBlock, UserMessage } from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import { StateSyncClientService } from "@harness/state-sync";
import { StreamClientService } from "@harness/stream";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { ChatPanel } from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { provideScope } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiSessionsService } from "@harness/ui-sessions";
import { UiStorageService } from "@harness/ui-storage";
import { UiTabsService, UiWorkbenchService } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import { createApp, h } from "vue";
import "virtual:uno.css";
import "../src/style.css";

const scope = createRootScope();
scope.provideAll([
  WebTransportConnection,
  [Transport, WebTransport],
  RpcClientService,
  StateSyncClientService,
  StreamClientService,
  UiStorageService,
  UiSessionsService,
  UiWorkspaceService,
  UiTabsService,
  UiWorkbenchService,
  UiNotificationService,
  UiChatManagerService,
]);

export async function openChatWithSavedImages() {
  const images = scope.run(() => scope.get(RpcClientService).use(ImageRpcContract));
  const session = scope.get(UiSessionsService).newSession();
  const uploads = await Promise.all(
    [1, 2].map((width) => {
      const image = document.createElement("canvas");
      image.width = width;
      image.height = 1;
      return images.upload({
        data: image.toDataURL("image/png").split(",")[1]!,
        mimeType: "image/png",
        filename: `${width}px.png`,
      });
    }),
  );
  const content = uploads.map(({ id, mimeType, filename }) =>
    ImageBlock.create({ fileId: id, mimeType, filename }),
  );
  scope
    .get(UiChatManagerService)
    .get(session)
    .queuedInputs.value.push(UserMessage.create({ content }));
  createApp({
    setup() {
      provideScope(scope);
      return () => h(ChatPanel);
    },
  }).mount("#app");
  return uploads.map(({ id }) => id);
}
