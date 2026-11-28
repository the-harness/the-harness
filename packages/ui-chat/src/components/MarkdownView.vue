<script lang="ts">
import { h } from "vue";
import { MarkdownRender, setCustomComponents, type CodeBlockNodeProps } from "markstream-vue";
import MarkdownCodeBlock from "./MarkdownCodeBlock.vue";

setCustomComponents("harness-markdown", {
  code_block: (props: { node: CodeBlockNodeProps["node"]; loading?: boolean }) =>
    h(MarkdownCodeBlock, {
      lang: props.node.language || "",
      code: props.node.code || "",
      complete: !props.loading && !props.node.loading,
    }),
});
</script>

<script setup lang="ts">
import { useService } from "@harness/ui-di";
import { UiWorkbenchService } from "@harness/ui-workbench";

withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const workbench = useService(UiWorkbenchService);
</script>

<template>
  <div class="markdown">
    <MarkdownRender
      custom-id="harness-markdown"
      :content="text"
      :final="!streaming"
      :is-dark="workbench.theme.value === 'dark'"
      :smooth-streaming="streaming"
      :show-tooltips="false"
      :node-virtual="false"
    />
  </div>
</template>

<style scoped>
.markdown :deep(thead th) {
  position: relative;
  white-space: nowrap;
}
.markdown :deep(.table-node__resize-handle) {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  z-index: 1;
  width: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}
@container (max-width: 480px) {
  .markdown :deep(thead th) {
    padding-left: 0;
  }
}
</style>
