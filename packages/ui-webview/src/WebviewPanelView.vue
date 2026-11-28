<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from "vue";
import { useService } from "@harness/ui-di";
import { TabContext } from "@harness/ui-workbench";
import { UiWebviewService } from "./index.ts";
import { WebviewTabDescriptor } from "./WebviewTab.ts";

const tabContext = useService(TabContext) as TabContext<WebviewTabDescriptor>;
const webview = useService(UiWebviewService);
const iframeRef = ref<HTMLIFrameElement | null>(null);
const ready = ref(false);
const channel = crypto.randomUUID();

const panel = computed(() => webview.panels.get(tabContext.descriptor.webviewId));
const html = computed(() => {
  const state = panel.value;
  if (!state?.enableScripts) return state?.html ?? "";
  const document = new DOMParser().parseFromString(state.html, "text/html");
  const nonce = crypto.randomUUID();
  for (const meta of document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')) {
    const directives = (meta.getAttribute("content") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    const scriptIndex = directives.findIndex((value) => /^script-src(?:\s|$)/.test(value));
    if (scriptIndex < 0) directives.push(`script-src 'nonce-${nonce}'`);
    else directives[scriptIndex] += ` 'nonce-${nonce}'`;
    meta.setAttribute("content", directives.join("; "));
  }
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  script.textContent = `(() => {
    const send = parent.postMessage.bind(parent);
    const channel = ${JSON.stringify(channel)};
    let acquired = false;
    let state = ${JSON.stringify(toRaw(state).state ?? null).replace(/</g, "\\u003c")};
    window.acquireVsCodeApi = () => {
      if (acquired) throw new Error('VS Code API has already been acquired');
      acquired = true;
      return Object.freeze({
        postMessage: message => send({ channel, type: 'message', message }, '*'),
        getState: () => state,
        setState: value => { state = value; send({ channel, type: 'state', state }, '*'); return value; }
      });
    };
    window.addEventListener('DOMContentLoaded', () => send({ channel, type: 'ready' }, '*'), { once: true });
  })();`;
  // The host bootstrap must run before any extension script; CSP metadata still precedes it.
  const firstExtensionScript = document.querySelector("script");
  if (firstExtensionScript) firstExtensionScript.before(script);
  else document.head.append(script);
  return "<!DOCTYPE html>" + document.documentElement.outerHTML;
});
watch(
  [iframeRef, html],
  ([frame, content]) => {
    if (!frame || frame.srcdoc === content) return;
    ready.value = false;
    // Navigate only after the mounted frame has its sandbox permissions.
    frame.srcdoc = content;
  },
  { flush: "post" },
);

function flushMessages() {
  if (!ready.value || !iframeRef.value?.contentWindow) return;
  const list = panel.value?.outbox;
  while (list?.length) iframeRef.value.contentWindow.postMessage(toRaw(list.shift()), "*");
}

watch(() => panel.value?.outbox.length ?? 0, flushMessages);

function onWindowMessage(event: MessageEvent) {
  if (event.source !== iframeRef.value?.contentWindow) return;
  if (event.data?.channel !== channel) return;
  if (event.data.type === "ready") {
    ready.value = true;
    flushMessages();
  } else if (event.data.type === "state") {
    if (panel.value) panel.value.state = event.data.state;
  } else if (event.data.type === "message")
    webview.emitMessage(tabContext.descriptor.webviewId, event.data.message);
}

onMounted(() => {
  window.addEventListener("message", onWindowMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onWindowMessage);
});
</script>

<template>
  <div class="webview-panel-view">
    <iframe
      :key="panel?.enableScripts ? 'scripts' : 'no-scripts'"
      ref="iframeRef"
      class="webview-iframe"
      :sandbox="panel?.enableScripts ? 'allow-scripts' : ''"
    />
  </div>
</template>

<style scoped>
.webview-panel-view {
  width: 100%;
  height: 100%;
  display: flex;
}

.webview-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}
</style>
