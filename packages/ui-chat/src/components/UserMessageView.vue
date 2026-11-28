<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: IconButton, ActionBar. Adaptation: compact timestamp, copy and reuse actions with a full-width hover area below the prompt, without layout height. -->
<script setup lang="ts">
import { IconButton } from "@harness/ui-components-base";
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { computed, nextTick, onScopeDispose, ref, shallowRef, useId, watch } from "vue";
import type { SessionMessage } from "../types.ts";
import { useImageSrc } from "../imageSrc.ts";
import ImageLightbox, { type LightboxImageItem } from "./ImageLightbox.vue";

const props = defineProps<{
  message: SessionMessage;
  onEdit?: (message: SessionMessage) => void;
}>();

const imageSrc = useImageSrc();
const notifications = useService(UiNotificationService);
const now = ref(Date.now());
const timestamp = computed(() => {
  if (props.message.timestamp === undefined) return undefined;
  const date = new Date(props.message.timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const today = new Date(now.value);
  const sameYear = date.getFullYear() === today.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return {
    iso: date.toISOString(),
    label: sameDay ? clock : `${sameYear ? "" : `${date.getFullYear()}年`}${day} ${clock}`,
    title: `${date.getFullYear()}年${day} ${clock}`,
  };
});
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => clearTimeout(copiedTimer));

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.message.text);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    notifications.notify("Clipboard is not available in this browser");
  }
}

const images = computed(() =>
  (props.message.images ?? []).flatMap((image, sourceIndex) => {
    const url = imageSrc(image);
    return url ? [{ url, filename: image.filename, sourceIndex }] : [];
  }),
);
const previewImages = shallowRef<readonly LightboxImageItem[]>([]);
const imageIndex = ref(-1);
const textId = useId();
const text = ref<HTMLElement>();
const previewLines = 6;
const expanded = ref(false);
const canExpand = ref(false);

function previewImage(index: number) {
  previewImages.value = images.value;
  imageIndex.value = index;
}

async function expandPrompt() {
  expanded.value = true;
  await nextTick();
  text.value?.focus({ preventScroll: true });
}

watch(text, (element, _, onCleanup) => {
  if (!element) {
    canExpand.value = false;
    return;
  }
  const measure = () => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    canExpand.value = element.scrollHeight > previewLines * lineHeight + 1;
  };
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  onCleanup(() => observer.disconnect());
  measure();
});
</script>

<template>
  <div class="u-turn" @mouseenter="now = Date.now()" @focusin="now = Date.now()">
    <div class="u-bub">
      <div v-if="images.length" class="prompt-images">
        <button
          v-for="(item, index) in images"
          :key="item.sourceIndex"
          type="button"
          class="prompt-image"
          :aria-label="`Preview ${item.filename || `image ${item.sourceIndex + 1}`}`"
          @click="previewImage(index)"
        >
          <img :src="item.url" alt="" />
        </button>
        <ImageLightbox
          v-model:index="imageIndex"
          :images="previewImages"
          @close="imageIndex = -1"
        />
      </div>
      <div v-if="message.text" :class="{ 'prompt-preview': !expanded }">
        <div :id="textId" ref="text" class="u-text" tabindex="-1">{{ message.text }}</div>
      </div>
      <button
        v-if="message.text && canExpand && !expanded"
        type="button"
        class="text-button prompt-toggle"
        :aria-controls="textId"
        aria-expanded="false"
        @click="expandPrompt"
      >
        Show more
      </button>
    </div>
    <div v-if="message.text || message.images?.length" class="prompt-actions">
      <time v-if="timestamp" class="prompt-time" :datetime="timestamp.iso" :title="timestamp.title">
        {{ timestamp.label }}
      </time>
      <IconButton
        v-if="message.text"
        :icon="copied ? 'i-codicon-check' : 'i-codicon-copy'"
        :label="copied ? 'Prompt copied' : 'Copy prompt'"
        @click="copyText"
      />
      <IconButton
        v-if="props.onEdit"
        icon="i-codicon-edit"
        label="Reuse prompt"
        @click="props.onEdit(message)"
      />
      <span class="sr-only" role="status">{{ copied ? "Prompt copied" : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
.u-turn {
  position: relative;
}

.prompt-preview {
  max-height: calc(v-bind(previewLines) * 1lh);
  overflow: hidden;
}

.prompt-toggle {
  display: block;
  margin-top: 4px;
  padding: 1px 0;
  color: var(--accent);
  font-size: 12px;
}

.prompt-actions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding-top: 2px;
  height: 20px;
  opacity: 0;
  transition: opacity 140ms ease-out;
}

.prompt-time {
  color: var(--subtle);
  font-size: 11px;
  white-space: nowrap;
}

.prompt-actions .icon-button {
  width: 18px;
  height: 18px;
  font-size: 12px;
}

.u-turn:hover .prompt-actions,
.u-turn:focus-within .prompt-actions {
  opacity: 1;
  pointer-events: auto;
}

.prompt-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.prompt-images:has(+ div) {
  margin-bottom: 6px;
}

.prompt-image {
  width: 56px;
  height: 56px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  cursor: zoom-in;
}

.prompt-image:hover {
  border-color: var(--accent);
}

.prompt-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

@media (prefers-reduced-motion: reduce) {
  .prompt-actions {
    transition: none;
  }
}
</style>
