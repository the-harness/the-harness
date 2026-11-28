<script setup lang="ts">
import { computed, ref, watch } from "vue";

export interface LightboxImageItem {
  readonly url: string;
  readonly filename?: string;
}

const props = defineProps<{
  readonly images: readonly LightboxImageItem[];
  readonly index: number;
}>();

const emit = defineEmits<{
  close: [];
  "update:index": [value: number];
}>();

const open = computed(() => props.images.length > 0 && props.index >= 0);
const current = computed(() => props.images[props.index]);
const hasPrev = computed(() => props.index > 0);
const hasNext = computed(() => props.index < props.images.length - 1);
const dialog = ref<HTMLDialogElement>();

function prev() {
  if (hasPrev.value) {
    emit("update:index", props.index - 1);
  }
}

function next() {
  if (hasNext.value) {
    emit("update:index", props.index + 1);
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    prev();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    next();
  }
}

watch(
  dialog,
  (element, _, onCleanup) => {
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    onCleanup(() => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    });
  },
  { flush: "post" },
);
</script>

<template>
  <Teleport to="body">
    <dialog
      v-if="open && current"
      ref="dialog"
      class="image-lightbox-backdrop"
      aria-label="Image preview"
      @click.self="emit('close')"
      @cancel.prevent="emit('close')"
      @keydown="onKeydown"
    >
      <button
        type="button"
        class="lightbox-close"
        aria-label="Close image preview"
        autofocus
        @click="emit('close')"
      >
        <span class="i-codicon-close" />
      </button>

      <button
        v-if="images.length > 1"
        type="button"
        class="lightbox-nav lightbox-prev"
        aria-label="Previous image"
        :disabled="!hasPrev"
        @click="prev"
      >
        <span class="i-codicon-chevron-left" />
      </button>

      <div class="lightbox-stage" @click.self="emit('close')">
        <img :src="current.url" :alt="current.filename ?? 'Image preview'" class="lightbox-img" />
        <div v-if="current.filename || images.length > 1" class="lightbox-caption">
          <span v-if="current.filename" class="lightbox-filename">{{ current.filename }}</span>
          <span v-if="images.length > 1" class="lightbox-counter">
            {{ index + 1 }} / {{ images.length }}
          </span>
        </div>
      </div>

      <button
        v-if="images.length > 1"
        type="button"
        class="lightbox-nav lightbox-next"
        aria-label="Next image"
        :disabled="!hasNext"
        @click="next"
      >
        <span class="i-codicon-chevron-right" />
      </button>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-lightbox-backdrop {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  align-items: center;
  justify-content: center;
}

.image-lightbox-backdrop[open] {
  display: flex;
}

.image-lightbox-backdrop::backdrop {
  background: rgba(0, 0, 0, 0.78);
  backdrop-filter: blur(4px);
}

.lightbox-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 90vw;
  max-height: 90vh;
}

.lightbox-img {
  max-width: 90vw;
  max-height: 82vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}

.lightbox-caption {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #f3f4f6;
  font-size: 12px;
}

.lightbox-filename {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox-counter {
  opacity: 0.78;
  font-variant-numeric: tabular-nums;
}

.lightbox-close,
.lightbox-nav {
  position: fixed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.72);
  color: #fff;
  cursor: pointer;
}

.lightbox-close:hover,
.lightbox-nav:hover:not(:disabled) {
  background: rgba(39, 39, 42, 0.92);
}

.lightbox-close {
  top: 16px;
  right: 16px;
}

.lightbox-prev {
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
}

.lightbox-next {
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
}
</style>
