import { createRootScope } from "@harness/di";
import { ImageBlock } from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { provideScope } from "@harness/ui-di";
import { createApp, h, ref } from "vue";
import UserMessageView from "../../../packages/ui-chat/src/components/UserMessageView.vue";

const scope = createRootScope();
scope.provideAll([WebTransportConnection, [Transport, WebTransport], RpcClientService]);

const messages = ["first", "second"].map((id) => ({
  id,
  role: "user" as const,
  text: id,
  images: [ImageBlock.create({ fileId: id, mimeType: "image/png" })],
}));

createApp({
  setup() {
    provideScope(scope);
    const showFirst = ref(true);
    return () => [
      h("button", { onClick: () => (showFirst.value = false) }, "Remove first message"),
      ...messages
        .filter((message) => message.id !== "first" || showFirst.value)
        .map((message) => h(UserMessageView, { key: message.id, message })),
    ];
  },
}).mount("#app");
