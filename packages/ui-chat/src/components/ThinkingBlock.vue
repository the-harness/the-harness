<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: Pane. Adaptation: single-line thinking preview with explicit disclosure. -->
<script setup lang="ts">
import { computed, ref, useId } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    duration?: string;
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const open = ref(false);
const bodyId = useId();
const preview = computed(() => {
  const paragraphs = props.text.split(/\r?\n[\t ]*\r?\n/);
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const paragraph = paragraphs[index]!;
    const firstLine = paragraph.split(/\r?\n/, 1)[0]!.trim();
    const sentence = firstLine.match(/^.*?(?:[。！？]|[.!?](?=\s|$))/u)?.[0];
    const complete = !props.streaming || index < paragraphs.length - 1 || paragraph.includes("\n");
    const summary = sentence ?? (complete ? firstLine : "");
    if (summary) return summary.replaceAll("**", "");
  }
  return "";
});
</script>

<template>
  <div class="think-block" :class="{ open, streaming }">
    <button
      type="button"
      class="think-head"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="open = !open"
    >
      <span class="think-ic" aria-hidden="true">
        <span class="i-codicon-lightbulb" />
      </span>
      <span class="think-title">
        {{ streaming ? "Thinking…" : duration ? `Thought for ${duration}` : "Thought" }}
      </span>
      <span v-if="!open && preview" class="think-preview">{{ preview }}</span>
      <span class="i-codicon-chevron-right think-car" aria-hidden="true" />
    </button>
    <div :id="bodyId" class="think-body" :class="{ open }" :inert="!open">
      <div class="think-body-inner">
        <pre class="think-text">{{ text }}</pre>
      </div>
    </div>
  </div>
</template>
