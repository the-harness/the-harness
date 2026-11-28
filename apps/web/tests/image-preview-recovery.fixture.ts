import { createRootScope } from "@harness/di";
import { ImageBlock } from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { provideScope } from "@harness/ui-di";
import { createApp, h, onScopeDispose, ref } from "vue";
import UserMessageView from "../../../packages/ui-chat/src/components/UserMessageView.vue";

createApp({
  setup() {
    const scope = createRootScope();
    scope.provideAll([WebTransportConnection, [Transport, WebTransport], RpcClientService]);
    provideScope(scope);
    onScopeDispose(() => scope.dispose());
    const revision = ref(0);
    const image = ImageBlock.create({ fileId: "stored-image", mimeType: "image/png" });
    return () => [
      h("button", { type: "button", onClick: () => revision.value++ }, "Update message"),
      h(UserMessageView, {
        message: {
          id: "restored-message",
          role: "user",
          text: `Restored image message ${revision.value}`,
          images: [image, image],
        },
      }),
    ];
  },
}).mount("#app");
