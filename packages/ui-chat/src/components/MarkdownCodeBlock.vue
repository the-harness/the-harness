<script setup lang="ts">
import { computed, onScopeDispose, ref } from "vue";
import { ContextMenu, IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiWorkbenchService } from "@harness/ui-workbench";
import { MarkdownHighlighterService, StreamingHighlightSession } from "../workbench/markdown";

const props = withDefaults(
  defineProps<{
    code: string;
    lang?: string;
    complete?: boolean;
    framed?: boolean;
  }>(),
  { lang: "", complete: true, framed: true },
);

const workbench = useService(UiWorkbenchService);
const notifications = useService(UiNotificationService);
const highlighter = useService(MarkdownHighlighterService);

void highlighter.load();
const session = new StreamingHighlightSession(highlighter);
const copied = ref(false);
const block = ref<HTMLElement>();
const selectionText = ref("");
const menuGroups = computed(() => workbench.codeMenu.resolve({
  code: props.code, language: props.lang, selection: selectionText.value,
  selectAll: () => {
    const code = block.value?.querySelector("pre code");
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  },
}));
function captureSelection() {
  const selection = window.getSelection();
  selectionText.value = selection?.anchorNode && block.value?.contains(selection.anchorNode)
    ? selection.toString() : "";
}
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => clearTimeout(copiedTimer));

const lines = computed(() => {
  void highlighter.ready.value;
  void highlighter.grammarVersion.value;
  return session.update(props.code, props.lang, workbench.theme.value);
});

const plainLines = computed(() => props.code.split("\n"));

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    notifications.notify("Clipboard is not available in this browser");
  }
}
</script>

<template>
  <ContextMenu label="Code actions" :groups="menuGroups"
    :on-error="() => notifications.notify('Clipboard is not available in this browser')">
    <div ref="block" class="md-code-block" :class="{ unframed: !framed }"
      @contextmenu.capture="captureSelection" @keydown.capture="captureSelection">
      <div v-if="framed" class="md-code-head">
        <span class="md-code-lang">{{ lang || "text" }}</span>
        <span class="spacer" />
        <IconButton
          :icon="copied ? 'i-codicon-check' : 'i-codicon-copy'"
          :label="copied ? 'Code copied' : 'Copy code'"
          @click="copyCode"
        />
        <span class="sr-only" role="status">{{ copied ? "Code copied" : "" }}</span>
      </div>
      <pre
        class="shiki md-code-pre"
      ><code><template v-if="lines"><span v-for="(line, lineIndex) in lines" :key="lineIndex" class="line"><span v-for="(span, spanIndex) in line" :key="spanIndex" :style="{ color: span.color, fontStyle: span.fontStyle && span.fontStyle & 1 ? 'italic' : undefined, fontWeight: span.fontStyle && span.fontStyle & 2 ? 'bold' : undefined }">{{ span.text }}</span>{{ lineIndex < lines.length - 1 ? "\n" : "" }}</span></template><template v-else><span v-for="(line, lineIndex) in plainLines" :key="lineIndex" class="line">{{ line }}{{ lineIndex < plainLines.length - 1 ? "\n" : "" }}</span></template></code></pre>
    </div>
  </ContextMenu>
</template>
