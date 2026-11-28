import { createRootScope } from "@harness/di";
import { ImageBlock } from "@harness/llm";
import { RpcClientService } from "@harness/rpc";
import { Transport, WebTransport, WebTransportConnection } from "@harness/transport";
import { UserMessageView, type SessionMessage } from "@harness/ui-chat";
import { provideScope } from "@harness/ui-di";
import { CrossTabSync, UiStorageService } from "@harness/ui-storage";
import { createApp, h, onScopeDispose } from "vue";
import { z } from "zod";
import "../src/style.css";

const prompt = Array.from({ length: 12 }, (_, index) => `Prompt line ${index + 1}`).join("\n");
const message: SessionMessage = {
  id: "replaced-prompt",
  role: "user",
  text: prompt,
  images: [
    ImageBlock.create({
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      filename: "replacement.png",
    }),
  ],
};

createApp({
  setup() {
    const scope = createRootScope();
    scope.provideAll([
      WebTransportConnection,
      [Transport, WebTransport],
      RpcClientService,
      UiStorageService,
    ]);
    provideScope(scope);
    onScopeDispose(() => scope.dispose());
    const content = scope.get(UiStorageService).use(
      "test:prompt-expander",
      { text: z.string().default(prompt) },
      new CrossTabSync(),
    );
    return () => [
      h("button", { type: "button", onClick: () => (content.text = "") }, "Clear prompt text"),
      h("button", { type: "button", onClick: () => (content.text = prompt) }, "Restore prompt text"),
      h(UserMessageView, { key: message.id, message: { ...message, text: content.text } }),
    ];
  },
}).mount("#app");
