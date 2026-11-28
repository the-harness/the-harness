<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: InputBox, Toolbar, Button, List, Pane, Dropdown, Menu, Tooltip. Adaptation: agent transcript and composer with Reka-managed preset selection, preset hover, keyboard navigation, dismissal and focus restoration. -->
<script lang="ts">
export { ChatBlockSlot, ChatTurnFooterSlot } from "../slots.ts";
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, useId, watch } from "vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "reka-ui";
import type { RunStopMessageData } from "../components/RunStopMessageView.vue";

import { ImageBlock, MessageMeta, TextBlock, UserMessage, type ContentBlock } from "@harness/llm";
import {
  getPendingImages,
  AssistantMessageView,
  ChatMessageSlot,
  getPendingText,
  RunStopMessageView,
  UserMessageView,
  getPendingTurnGroup,
  TurnGroupField,
  UiChatService,
  type SessionMessage,
  type ChatMenuContext,
  type SyncListTarget,
} from "@harness/ui-chat";
import { UiChatManagerService } from "@harness/ui-chat-manager";
import { ActionMenu, Button, ContextMenu, IconButton } from "@harness/ui-components-base";
import { createModelMenu } from "../menus.ts";
import { useService } from "@harness/ui-di";
import { UiNotificationService } from "@harness/ui-notifications";
import { UiSessionsService } from "@harness/ui-sessions";
import { ChatInputNotificationSlot, ChatComposerSlot } from "@harness/ui-workbench";
import { UiWorkspaceService } from "@harness/ui-workspace";
import ImageLightbox, { type LightboxImageItem } from "../components/ImageLightbox.vue";
import PresetIcon from "../components/PresetIcon.vue";
import { ImageRpcContract } from "@harness/image-storage/contract";
import { RpcClientService } from "@harness/rpc";
import { readFileAsBase64, useImageSrc } from "../imageSrc.ts";

function isRunStopMessage(value: unknown): value is RunStopMessageData {
  return (
    typeof value === "object" &&
    value !== null &&
    "stopReason" in value &&
    typeof (value as { stopReason: unknown }).stopReason === "string"
  );
}
const workspaceService = useService(UiWorkspaceService);
const sessions = useService(UiSessionsService);
const imageRpc = useService(RpcClientService).use(ImageRpcContract);
const unavailableImages = reactive(new Set<string>());
const imageSrc = useImageSrc((id) => unavailableImages.add(id));
const notifications = useService(UiNotificationService);
const chatManager = useService(UiChatManagerService);

const current = sessions.current;
const sessionWorkspace = computed(() =>
  current.value
    ? (workspaceService.getWorkspace(current.value.workspaceId) ??
      workspaceService.currentWorkspace.value)
    : workspaceService.currentWorkspace.value,
);
const activeChat = computed(() => (current.value ? chatManager.get(current.value.id) : undefined));
const messages = computed(() => activeChat.value?.messages.value ?? []);
const pendingInputs = computed(() => activeChat.value?.pendingInputs.value ?? []);
const queuedInputs = computed(() => activeChat.value?.queuedInputs.value ?? []);
const chatNotice = computed(() => activeChat.value?.notice.value ?? "");
const draft = computed({
  get: () => queueEdit.value?.text ?? activeChat.value?.draft.value ?? "",
  set: (value: string) => {
    if (queueEdit.value) queueEdit.value.text = value;
    else if (activeChat.value) activeChat.value.draft.value = value;
  },
});
const modelMenu = createModelMenu(chatManager);
const model = chatManager.selectedModel;
const presets = computed(() => activeChat.value?.presets.value ?? []);
const selectedPreset = computed(() => activeChat.value?.selectedPreset.value);
const isPresetLocked = computed(() => activeChat.value?.isPresetLocked.value ?? false);
const presetMenuOpen = ref(false);
const presetId = computed({
  get: () => activeChat.value?.preset.value ?? "",
  set: (value: string) => {
    if (activeChat.value) activeChat.value.preset.value = value;
  },
});
watch(
  () => current.value?.id,
  () => {
    presetMenuOpen.value = false;
  },
);

interface ComposerImageItem {
  readonly localId: string;
  readonly previewUrl: string;
  readonly isObjectUrl: boolean;
  readonly filename?: string;
  readonly file?: File;
  status: "uploading" | "ready" | "error";
  error?: string;
  uploaded?: ImageBlock;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const draftUploads = ref<ComposerImageItem[]>([]);
const restoredDraftImages = computed(
  () => activeChat.value?.draftImages.value.map(toComposerImageItem) ?? [],
);
const queueEdit = ref<{
  readonly sessionId: string;
  readonly itemId: string;
  text: string;
  images: ComposerImageItem[];
} | null>(null);
const editingItemId = computed(() => queueEdit.value?.itemId ?? null);
const composerImages = computed(
  () => queueEdit.value?.images ?? [...restoredDraftImages.value, ...draftUploads.value],
);
const attachmentStatusId = useId();
const isDragOverComposer = ref(false);
let dragOverDepth = 0;
const lightboxImages = ref<readonly LightboxImageItem[]>([]);
const lightboxIndex = ref(-1);
const upload = ref<HTMLInputElement>();
const transcript = ref<HTMLElement>();
const messageFlow = ref<HTMLElement>();
const composerForm = ref<HTMLFormElement>();
const presetTriggerIcon = ref<HTMLElement>();
const composerPresetIcon = ref<HTMLElement>();
const composerToolbar = ref<HTMLElement>();
const isPresetMoving = ref(false);
const queueList = ref<HTMLElement>();
const messageInput = ref<HTMLTextAreaElement>();
const follow = ref(true);
const showJumpPill = ref(false);
const hasTranscriptOverflow = ref(false);
watch(
  [transcript, messageFlow],
  ([viewport, content], _previous, onCleanup) => {
    if (!viewport || !content) return;
    let previousSize = viewport.getBoundingClientRect();
    const measure = async () => {
      // A scrollbar changes clientWidth without resizing the conversation.
      const size = viewport.getBoundingClientRect();
      const resized = previousSize.width !== size.width || previousSize.height !== size.height;
      previousSize = size;
      hasTranscriptOverflow.value = content.getBoundingClientRect().height > viewport.clientHeight;
      if (!hasTranscriptOverflow.value) {
        showJumpPill.value = false;
      } else if (resized && follow.value && !loadingOlder.value) {
        await nextTick();
        if (transcript.value === viewport && follow.value && !loadingOlder.value) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      }
      if (transcript.value === viewport) updateJumpPill(viewport);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && viewport.contains(selection.anchorNode)) {
        follow.value = false;
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("selectionchange", onSelectionChange);
    });
  },
  { flush: "post" },
);
const PAGE_SIZE = 30;
const visibleCount = ref(PAGE_SIZE);
const olderRequest = ref<symbol>();
const loadingOlder = computed(() => olderRequest.value !== undefined);
const visibleMessages = computed(() => messages.value.slice(-visibleCount.value));
const hasOlderMessages = computed(
  () =>
    messages.value.length > visibleCount.value || (activeChat.value?.hasMoreMessages() ?? false),
);

// Prompt recall: ↑ from the start of the composer walks back through earlier prompts, ↓ walks forward.
const composerHistory = computed(() =>
  current.value ? chatManager.composerHistory(current.value.id) : undefined,
);

const TREE_INDENT_PX = 20;

const dragState = ref<{
  fromFlat: number;
  hoverFlat: number;
  initialDepth: 0 | 1;
  targetDepth: 0 | 1;
  offsetY: number;
  draggedHeight: number;
} | null>(null);

const isSessionRunning = computed(() => chatManager.isRunning(current.value?.id));
const readyComposerImages = computed<ImageBlock[]>(() =>
  composerImages.value
    .filter(
      (item): item is ComposerImageItem & { uploaded: ImageBlock } =>
        item.status === "ready" && item.uploaded !== undefined,
    )
    .map((item) => item.uploaded),
);
const attachmentStatus = computed(() => {
  if (!queueEdit.value) {
    const stored = activeChat.value?.draftImages.value ?? [];
    if (stored.some((image) => image.fileId && unavailableImages.has(image.fileId))) {
      return "A saved image is unavailable. Remove it and attach the file again.";
    }
    if (stored.some((image) => !imageSrc(image))) return "Loading saved images…";
  }
  if (composerImages.value.some((item) => item.status === "error")) {
    return "Retry or remove failed images.";
  }
  if (composerImages.value.some((item) => item.status === "uploading")) {
    return "Uploading images…";
  }
  return "";
});
const hasDraftContent = computed(
  () => Boolean(draft.value.trim()) || readyComposerImages.value.length > 0,
);
const stopIsPrimary = computed(
  () =>
    isSessionRunning.value &&
    editingItemId.value === null &&
    !draft.value.trim() &&
    composerImages.value.length === 0,
);
const totalQueuedCount = computed(() => pendingInputs.value.length + queuedInputs.value.length);
const canSend = computed(
  () =>
    activeChat.value !== undefined &&
    !attachmentStatus.value &&
    (hasDraftContent.value || (!isSessionRunning.value && totalQueuedCount.value > 0)),
);
const canSteer = computed(
  () =>
    activeChat.value !== undefined &&
    !attachmentStatus.value &&
    (hasDraftContent.value || queuedInputs.value.length > 0),
);
const sendAction = computed(() => {
  if (isSessionRunning.value || (hasDraftContent.value && queuedInputs.value.length > 0)) {
    return { label: "Queue message", icon: "queue" };
  }
  if (!hasDraftContent.value && totalQueuedCount.value > 0) {
    return { label: "Resume queue", icon: "i-codicon-play" };
  }
  return { label: "Send message", icon: "i-codicon-send" };
});
interface QueueTreeEntry {
  item: UserMessage;
  target: SyncListTarget;
  index: number;
  flatIndex: number;
  depth: 0 | 1;
}

const flatQueueItems = computed<QueueTreeEntry[]>(() => {
  const pending = pendingInputs.value;
  const queued = queuedInputs.value;
  const entries: QueueTreeEntry[] = [];
  for (let index = 0; index < pending.length; index++) {
    entries.push({
      item: pending[index]!,
      target: "pending",
      index,
      flatIndex: entries.length,
      depth: index === 0 ? 0 : 1,
    });
  }
  for (let index = 0; index < queued.length; index++) {
    const item = queued[index]!;
    const sameGroupAsPrev =
      index > 0 && getPendingTurnGroup(queued[index - 1]!) === getPendingTurnGroup(item);
    entries.push({
      item,
      target: "queue",
      index,
      flatIndex: entries.length,
      depth: sameGroupAsPrev ? 1 : 0,
    });
  }
  return entries;
});

function toComposerImageItem(image: ImageBlock): ComposerImageItem {
  return {
    localId: `remote:${image.fileId ?? image.url ?? ""}:${crypto.randomUUID()}`,
    previewUrl: "",
    isObjectUrl: false,
    filename: image.filename,
    status: "ready",
    uploaded:
      image instanceof ImageBlock
        ? image
        : ImageBlock.create({
            mimeType: image.mimeType,
            ...(image.data ? { data: image.data } : {}),
            ...(image.url ? { url: image.url } : {}),
            ...(image.fileId ? { fileId: image.fileId } : {}),
            ...(image.filename ? { filename: image.filename } : {}),
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
            ...(image.detail !== undefined ? { detail: image.detail } : {}),
          }),
  };
}

function revokeComposerImages(items: readonly ComposerImageItem[]) {
  for (const item of items) {
    if (item.isObjectUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

function clearUploads(items: ComposerImageItem[]): void {
  revokeComposerImages(items);
  items.length = 0;
}

function composerPreviewSrc(item: ComposerImageItem): string | undefined {
  if (item.uploaded?.fileId && unavailableImages.has(item.uploaded.fileId)) return undefined;
  return item.previewUrl || (item.uploaded ? imageSrc(item.uploaded) : undefined);
}

function openLightbox(images: readonly LightboxImageItem[], index: number) {
  if (images.length === 0) return;
  lightboxImages.value = images;
  lightboxIndex.value = index;
}

function closeLightbox() {
  lightboxIndex.value = -1;
  lightboxImages.value = [];
}

function openComposerLightbox(index: number) {
  openLightbox(
    composerImages.value.map((item) => ({
      get url() {
        return composerPreviewSrc(item) ?? "";
      },
      filename: item.filename,
    })),
    index,
  );
}

function openImageBlocksLightbox(images: readonly ImageBlock[], index: number) {
  openLightbox(
    images.map((image) => ({
      get url() {
        return imageSrc(image) ?? "";
      },
      filename: image.filename,
    })),
    index,
  );
}

function readImageDimensions(url: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}

async function uploadComposerImage(item: ComposerImageItem) {
  const chat = activeChat.value;
  const edit = queueEdit.value;
  const items = edit?.images ?? draftUploads.value;
  if (!chat || !item.file || !items.includes(item)) return;
  item.status = "uploading";
  item.error = undefined;
  try {
    const dimensionsPromise = readImageDimensions(item.previewUrl);
    const uploaded = await imageRpc.upload({
      data: await readFileAsBase64(item.file),
      mimeType: item.file.type || "image/png",
      ...(item.file.name ? { filename: item.file.name } : {}),
    });
    const dims = await dimensionsPromise;
    if (!items.includes(item)) return;
    const image = ImageBlock.create({
      mimeType: uploaded.mimeType,
      fileId: uploaded.id,
      ...(uploaded.filename ? { filename: uploaded.filename } : {}),
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    });
    if (edit) {
      item.uploaded = image;
      item.status = "ready";
    } else {
      unavailableImages.delete(uploaded.id);
      chat.draftImages.value = [...chat.draftImages.value, image];
      items.splice(items.indexOf(item), 1);
      revokeComposerImages([item]);
    }
  } catch (error) {
    if (!items.includes(item)) return;
    item.status = "error";
    item.error = error instanceof Error ? error.message : String(error);
    notifications.notify(`Image upload failed: ${item.error}`);
  }
}

function addFiles(files: readonly File[]) {
  if (!activeChat.value) return;
  const items = queueEdit.value?.images ?? draftUploads.value;
  for (const file of files) {
    if (SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
      const item: ComposerImageItem = reactive({
        localId: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        isObjectUrl: true,
        filename: file.name || undefined,
        file,
        status: "uploading",
      });
      items.push(item);
      void uploadComposerImage(item);
    } else if (file.name) {
      notifications.notify(`Unsupported file type: ${file.name}`);
    }
  }
}

function removeComposerImage(item: ComposerImageItem) {
  const edit = queueEdit.value;
  const chat = activeChat.value;
  const index = restoredDraftImages.value.indexOf(item);
  if (!edit && chat && index !== -1) {
    chat.draftImages.value = chat.draftImages.value.filter(
      (_image, position) => position !== index,
    );
    return;
  }
  const items = edit?.images ?? draftUploads.value;
  if (!items.includes(item)) return;
  items.splice(items.indexOf(item), 1);
  revokeComposerImages([item]);
}

function clearQueueEdit(): void {
  const edit = queueEdit.value;
  queueEdit.value = null;
  if (edit) clearUploads(edit.images);
}

function finishEditing(focusComposer = true) {
  if (!queueEdit.value) return;
  clearQueueEdit();
  if (focusComposer) void nextTick(() => messageInput.value?.focus());
}

async function startEditing(item: UserMessage) {
  const sessionId = current.value?.id;
  if (!sessionId || (queueEdit.value && attachmentStatus.value)) return;
  if (editingItemId.value === item.id) {
    messageInput.value?.focus();
    return;
  }
  clearQueueEdit();
  queueEdit.value = {
    sessionId,
    itemId: item.id,
    text: getPendingText(item),
    images: getPendingImages(item).map(toComposerImageItem),
  };
  await nextTick();
  messageInput.value?.focus();
}

watch(editingItemId, (id, _, onCleanup) => {
  if (id === null) return;
  const finishOnOutsideClick = (event: MouseEvent) => {
    if (event.button !== 0 || attachmentStatus.value || lightboxIndex.value >= 0 || messageMenuOpen.value) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (composerForm.value?.contains(target)) return;
    if (queueList.value?.querySelector(".pending-item.editing")?.contains(target)) return;
    finishEditing(false);
  };
  window.addEventListener("click", finishOnOutsideClick, true);
  onCleanup(() => window.removeEventListener("click", finishOnOutsideClick, true));
});

function buildComposerContent(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.length > 0) {
    blocks.push(TextBlock.create({ text }));
  }
  blocks.push(...readyComposerImages.value);
  return blocks;
}

watch(
  () => {
    const edit = queueEdit.value;
    return [edit, edit?.text, ...(edit ? readyComposerImages.value : [])] as const;
  },
  ([edit], [previousEdit]) => {
    if (!edit || edit !== previousEdit || edit.sessionId !== current.value?.id) return;
    for (const items of [pendingInputs.value, queuedInputs.value]) {
      const idx = items.findIndex((item) => item.id === edit.itemId);
      if (idx !== -1) {
        const currentItem = items[idx]!;
        const updated = UserMessage.create({
          id: currentItem.id,
          meta: new MessageMeta(currentItem.meta),
          content: buildComposerContent(edit.text),
        });
        updated.meta.set(TurnGroupField, getPendingTurnGroup(currentItem));
        items[idx] = updated;
        break;
      }
    }
  },
  { flush: "sync" },
);

watch(
  () => [...pendingInputs.value, ...queuedInputs.value].map((item) => item.id),
  (ids) => {
    const edit = queueEdit.value;
    if (edit && !ids.includes(edit.itemId)) {
      const activeElement = document.activeElement;
      finishEditing(
        Boolean(
          composerForm.value?.contains(activeElement) ||
          queueList.value?.querySelector(".pending-item.editing")?.contains(activeElement),
        ),
      );
    }
  },
);

watch(
  () => current.value?.id,
  () => {
    presetMenuOpen.value = false;
    clearQueueEdit();
    clearUploads(draftUploads.value);
    closeLightbox();
  },
  { flush: "sync" },
);

watch(
  [isPresetLocked, () => current.value?.id],
  async ([locked, id], [wasLocked, previousId], onCleanup) => {
    if (
      !locked ||
      wasLocked ||
      id !== previousId ||
      !isSessionRunning.value ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const from = presetTriggerIcon.value?.getBoundingClientRect();
    const previousModel = composerToolbar.value
      ?.querySelector<HTMLElement>(".menu-trigger")
      ?.getBoundingClientRect();
    if (!from?.width || !previousModel?.width) return;
    const animations: Animation[] = [];
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
      isPresetMoving.value = false;
      animations.forEach((animation) => animation.cancel());
    });
    await nextTick();
    const icon = composerPresetIcon.value;
    const modelButton = composerToolbar.value?.querySelector<HTMLElement>(".menu-trigger");
    if (cancelled || !icon || !modelButton) return;
    const to = icon.getBoundingClientRect();
    const nextModel = modelButton.getBoundingClientRect();
    if (!to.width || !nextModel.width) return;
    isPresetMoving.value = true;
    const timing = { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    animations.push(
      icon.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`,
          },
          { transformOrigin: "top left", transform: "none" },
        ],
        timing,
      ),
      modelButton.animate(
        [
          {
            transform: `translate(${previousModel.x - nextModel.x}px, ${previousModel.y - nextModel.y}px)`,
          },
          { transform: "none" },
        ],
        timing,
      ),
    );
    const separator = composerToolbar.value?.querySelector<HTMLElement>(".composer-preset-separator");
    if (separator) {
      animations.push(
        separator.animate(
          [{ opacity: 0 }, { opacity: getComputedStyle(separator).opacity }],
          { ...timing, duration: 160, delay: 100, fill: "backwards" },
        ),
      );
    }
    await Promise.allSettled(animations.map((animation) => animation.finished));
    if (!cancelled) isPresetMoving.value = false;
  },
);

function onFormSubmit() {
  if (editingItemId.value !== null) {
    if (!attachmentStatus.value) finishEditing();
    return;
  }
  submitComposer();
}

function submitComposer(steered = false) {
  const chat = activeChat.value;
  if (!chat || !(steered ? canSteer.value : canSend.value)) return;
  const content = buildComposerContent(draft.value.trim());
  if (steered) {
    void chat.steer(content);
  } else {
    void chat.send(content);
  }
  clearUploads(draftUploads.value);
  follow.value = true;
  showJumpPill.value = false;
}

function stop() {
  activeChat.value?.abort();
  messageInput.value?.focus();
}

function sameTurn(a: QueueTreeEntry | undefined, b: QueueTreeEntry | undefined): boolean {
  if (!a || !b || a.target !== b.target) return false;
  if (a.target === "pending") return true;
  return getPendingTurnGroup(a.item) === getPendingTurnGroup(b.item);
}

function getItemDragStyle(flatIndex: number) {
  const active = dragState.value;
  if (!active) return undefined;
  const { fromFlat, hoverFlat, offsetY, draggedHeight } = active;
  if (flatIndex === fromFlat) {
    return { transform: `translate3d(0, ${offsetY}px, 0)` };
  }
  if (fromFlat < hoverFlat && flatIndex > fromFlat && flatIndex <= hoverFlat) {
    return { transform: `translate3d(0, ${-draggedHeight}px, 0)` };
  }
  if (fromFlat > hoverFlat && flatIndex >= hoverFlat && flatIndex < fromFlat) {
    return { transform: `translate3d(0, ${draggedHeight}px, 0)` };
  }
  return undefined;
}

let activeDragCleanup: (() => void) | null = null;

function cancelActiveDrag() {
  activeDragCleanup?.();
  activeDragCleanup = null;
  dragState.value = null;
}

onBeforeUnmount(cancelActiveDrag);

watch([activeChat, () => flatQueueItems.value.map((entry) => entry.item.id).join(",")], () => {
  if (dragState.value) {
    cancelActiveDrag();
  }
});

function onGripPointerDown(fromFlat: number, event: PointerEvent) {
  const chat = activeChat.value;
  if (!chat || event.button !== 0 || dragState.value) return;
  const entries = flatQueueItems.value;
  const source = entries[fromFlat];
  if (!source) return;

  event.preventDefault();
  const gripEl = event.currentTarget as HTMLElement | null;
  const listEl = gripEl?.closest<HTMLElement>(".pending-queue-list");
  if (!listEl) return;

  const itemEls = Array.from(listEl.querySelectorAll<HTMLElement>(".pending-item"));
  if (itemEls.length <= 1 || fromFlat < 0 || fromFlat >= itemEls.length) return;

  const rects = itemEls.map((el) => el.getBoundingClientRect());
  const draggedRect = rects[fromFlat]!;
  const draggedHeight = draggedRect.height;
  const minOffsetY = rects[0]!.top - draggedRect.top;
  const maxOffsetY = rects[rects.length - 1]!.bottom - draggedRect.bottom;
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  const initialDepth = source.depth;
  const remaining = entries.filter((_, i) => i !== fromFlat);
  const remainingPendingCount = remaining.filter((entry) => entry.target === "pending").length;

  try {
    gripEl?.setPointerCapture(pointerId);
  } catch {
    // Synthetic pointer events in tests may not have an active pointer id.
  }

  dragState.value = {
    fromFlat,
    hoverFlat: fromFlat,
    initialDepth,
    targetDepth: initialDepth,
    offsetY: 0,
    draggedHeight,
  };

  const resolveDepth = (hoverFlat: number, rawDeltaX: number): 0 | 1 => {
    const prev = remaining[hoverFlat - 1];
    const next = remaining[hoverFlat];
    if (!prev) return 0;
    if (sameTurn(prev, next)) return 1;
    const effectiveX = initialDepth * TREE_INDENT_PX + rawDeltaX;
    return effectiveX >= TREE_INDENT_PX / 2 ? 1 : 0;
  };

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId || activeChat.value !== chat) return;
    const active = dragState.value;
    if (!active) return;

    const rawDeltaX = moveEvent.clientX - startX;
    const rawDeltaY = moveEvent.clientY - startY;
    const offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, rawDeltaY));
    const draggedCenterY = draggedRect.top + draggedHeight / 2 + rawDeltaY;

    let hoverFlat = fromFlat;
    if (rawDeltaY < 0) {
      for (let i = 0; i < fromFlat; i++) {
        if (draggedCenterY < rects[i]!.top + rects[i]!.height / 2) {
          hoverFlat = i;
          break;
        }
      }
    } else if (rawDeltaY > 0) {
      for (let i = rects.length - 1; i > fromFlat; i--) {
        if (draggedCenterY > rects[i]!.top + rects[i]!.height / 2) {
          hoverFlat = i;
          break;
        }
      }
    }

    const targetDepth = resolveDepth(hoverFlat, rawDeltaX);
    dragState.value = {
      ...active,
      hoverFlat,
      targetDepth,
      offsetY,
    };
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerEnd, true);
    window.removeEventListener("pointercancel", onPointerEnd, true);
    try {
      gripEl?.releasePointerCapture(pointerId);
    } catch {
      // Ignore when pointer capture was not active.
    }
    if (activeDragCleanup === cleanup) {
      activeDragCleanup = null;
    }
  };

  const onPointerEnd = (endEvent: PointerEvent) => {
    if (endEvent.pointerId !== pointerId) return;
    if (endEvent.type === "pointercancel" || activeChat.value !== chat) {
      cancelActiveDrag();
      return;
    }
    cleanup();

    const active = dragState.value;
    if (!active) return;

    const { hoverFlat, targetDepth } = active;
    dragState.value = null;
    if (hoverFlat === fromFlat && targetDepth === initialDepth) return;

    const move = (toTarget: SyncListTarget, toIndex: number, turnGroup?: string) => {
      const sourceItems = source.target === "pending" ? pendingInputs.value : queuedInputs.value;
      const destItems = toTarget === "pending" ? pendingInputs.value : queuedInputs.value;
      const [moved] = sourceItems.splice(source.index, 1);
      if (!moved) return;
      let nextItem = moved;
      if (toTarget === "queue" && turnGroup && getPendingTurnGroup(moved) !== turnGroup) {
        nextItem = UserMessage.create({
          id: moved.id,
          meta: new MessageMeta(moved.meta),
          content: [...moved.content],
        });
        nextItem.meta.set(TurnGroupField, turnGroup);
      }
      destItems.splice(Math.max(0, Math.min(toIndex, destItems.length)), 0, nextItem);
    };

    const prev = remaining[hoverFlat - 1];
    if (targetDepth === 1 && prev) {
      if (prev.target === "pending") {
        move("pending", hoverFlat);
      } else {
        move("queue", hoverFlat - remainingPendingCount, getPendingTurnGroup(prev.item));
      }
      return;
    }

    if (hoverFlat === 0 && remainingPendingCount > 0) {
      move("pending", 0);
      return;
    }

    move("queue", hoverFlat - remainingPendingCount, crypto.randomUUID());
  };

  activeDragCleanup = cleanup;
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
}

function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  addFiles(Array.from(input.files ?? []));
  input.value = "";
}

function drop(event: DragEvent) {
  dragOverDepth = 0;
  isDragOverComposer.value = false;
  if (event.dataTransfer?.files.length) {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  }
}

function hasFileDrag(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types?.includes("Files"));
}

function onComposerDragEnter(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  dragOverDepth += 1;
  isDragOverComposer.value = true;
}

function onComposerDragOver(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  isDragOverComposer.value = true;
}

function onComposerDragLeave(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  dragOverDepth = Math.max(0, dragOverDepth - 1);
  if (dragOverDepth === 0) {
    isDragOverComposer.value = false;
  }
}

function onComposerPaste(event: ClipboardEvent) {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageFiles: File[] = [];
  for (const item of items) {
    if (item.kind === "file" && SUPPORTED_IMAGE_MIME_TYPES.has(item.type.toLowerCase())) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length === 0) return;
  const hasText = Boolean(event.clipboardData?.getData("text/plain"));
  if (!hasText) {
    event.preventDefault();
  }
  addFiles(imageFiles);
}

function applyComposerCaret(caret: number) {
  void nextTick(() => {
    const input = messageInput.value;
    if (!input) return;
    input.focus();
    input.setSelectionRange(caret, caret);
  });
}

function onComposerRecallKey(event: KeyboardEvent): boolean {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  const input = messageInput.value;
  const history = composerHistory.value;
  if (!input || !history || input.selectionStart !== input.selectionEnd) return false;
  const caret =
    event.key === "ArrowUp"
      ? history.navigateOlder(input.selectionStart)
      : history.navigateNewer(input.selectionStart);
  if (caret === null) return false;
  applyComposerCaret(caret);
  return true;
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const editing = editingItemId.value !== null;
  if (editing && event.key === "Escape") {
    event.preventDefault();
    onFormSubmit();
    return;
  }
  if (!editing && onComposerRecallKey(event)) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
  const modified = event.metaKey || event.ctrlKey;
  if (modified && editing) return;
  event.preventDefault();
  if (modified) {
    submitComposer(true);
    return;
  }
  onFormSubmit();
}

const messageMenu = ref<InstanceType<typeof ContextMenu>>();
const messageMenuOpen = ref(false);
let messageMenuReturnFocus: HTMLElement | undefined;
function rememberMessageMenuFocus(event: PointerEvent) {
  if (event.button === 2) {
    messageMenuReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined;
  }
}
const menuTarget = shallowRef<{
  chat: UiChatService;
  context: Pick<ChatMenuContext, "selection" | "link"> & { messageId?: string; inputId?: string };
  element: HTMLElement;
  link?: HTMLAnchorElement;
}>();
const messageMenuGroups = computed(() => {
  const target = menuTarget.value;
  if (!target || target.chat !== activeChat.value) return [];
  const { inputId, messageId } = target.context;
  const entry = inputId === undefined ? undefined : flatQueueItems.value.find(({ item }) => item.id === inputId);
  const message = messageId === undefined ? undefined : visibleMessages.value.find((item) => item.id === messageId);
  if ((inputId !== undefined && !entry) || (messageId !== undefined && !message)) return [];
  return target.chat.menu.resolve({
    message, input: entry?.item, selection: target.context.selection, link: target.context.link,
    canEdit: editingItemId.value === null || !attachmentStatus.value,
    canReuse: editingItemId.value === null,
    edit: () => { if (entry) startEditing(entry.item); },
    remove: async () => {
      if (!entry) return;
      const items = entry.target === "pending" ? pendingInputs.value : queuedInputs.value;
      const index = items.findIndex((item) => item.id === entry.item.id);
      if (index !== -1) items.splice(index, 1);
      await nextTick();
      if (document.activeElement === document.body) messageInput.value?.focus();
    },
    openLink: () => target.link?.click(),
    reuse: () => { if (message) editUserMessage(message); },
    selectAll: () => {
      const range = document.createRange();
      range.selectNodeContents(target.element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
  });
});

async function openMessageMenu(message: SessionMessage | undefined, event: MouseEvent | KeyboardEvent, inputId?: string) {
  if (event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const target = event.target;
  const element = event.currentTarget;
  const chat = activeChat.value;
  if (!chat || !(target instanceof HTMLElement) || !(element instanceof HTMLElement)) return;
  if (target.closest('input, textarea, [contenteditable="true"], img, .prompt-image, .md-code-block')) return;
  const selection = window.getSelection();
  const link = target.closest<HTMLAnchorElement>("a[href]") ?? undefined;
  menuTarget.value = { chat, element, link, context: {
    messageId: message?.id, inputId,
    selection: selection?.anchorNode && element.contains(selection.anchorNode) ? selection.toString() : "",
    link: link?.href,
  } };
  event.preventDefault();
  event.stopPropagation();
  const returnFocus = event instanceof KeyboardEvent ? target
    : messageMenuReturnFocus?.isConnected && messageMenuReturnFocus !== document.body
      ? messageMenuReturnFocus : element;
  messageMenuReturnFocus = undefined;
  await nextTick();
  messageMenu.value?.show(event instanceof MouseEvent ? event : target, returnFocus);
}

function editUserMessage(message: SessionMessage) {
  if (!current.value || editingItemId.value !== null) return;
  if (
    (draft.value.trim() || composerImages.value.length) &&
    !window.confirm("Replace the current draft with this prompt?")
  ) {
    return;
  }
  const chat = activeChat.value;
  if (!chat) return;
  const images = message.images ?? [];
  clearUploads(draftUploads.value);
  chat.draftImages.value = images;
  draftUploads.value.push(...images.filter((image) => !image.fileId).map(toComposerImageItem));
  draft.value = message.text;
  void nextTick(() => messageInput.value?.focus());
}

function startConversation() {
  sessions.newSession(sessionWorkspace.value?.id);
  void nextTick(() => messageInput.value?.focus());
}

async function loadOlderMessages(event?: MouseEvent) {
  const chat = activeChat.value;
  if (!chat || loadingOlder.value || !hasOlderMessages.value) return;
  const el = transcript.value;
  const button =
    event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
  const restoreFocus = button !== undefined && button === document.activeElement;
  const request = Symbol();
  olderRequest.value = request;
  const isCurrent = () => olderRequest.value === request && activeChat.value === chat;
  const prevScrollHeight = el?.scrollHeight ?? 0;
  const prevScrollTop = el?.scrollTop ?? 0;
  try {
    if (messages.value.length > visibleCount.value) {
      visibleCount.value = Math.min(messages.value.length, visibleCount.value + PAGE_SIZE);
    } else {
      const added = await chat.loadOlder();
      if (!isCurrent()) return;
      if (added > 0) {
        visibleCount.value += added;
      }
    }
    if (el) {
      await nextTick();
      if (isCurrent() && transcript.value === el) {
        el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
      }
    }
  } catch {
    if (isCurrent()) notifications.notify("Earlier messages could not be loaded");
  } finally {
    const shouldRestoreFocus = restoreFocus && isCurrent();
    if (olderRequest.value === request) olderRequest.value = undefined;
    if (shouldRestoreFocus) {
      await nextTick();
      if (
        !loadingOlder.value &&
        chat === activeChat.value &&
        transcript.value === el &&
        document.activeElement === document.body
      ) {
        (button?.isConnected ? button : el)?.focus({ preventScroll: true });
      }
    }
  }
}

function distanceToLatest(el: HTMLElement) {
  const latest = el.querySelector(".chat-row:last-child");
  return latest
    ? latest.getBoundingClientRect().bottom - el.getBoundingClientRect().top - el.clientHeight
    : 0;
}

async function onTranscriptDisclosure(event: MouseEvent | KeyboardEvent) {
  const viewport = transcript.value;
  if (!viewport || !(event.target instanceof Element)) return;
  const control = event.target.closest<HTMLElement>('button, [role="button"]');
  if (!control?.hasAttribute("aria-expanded") || !control.hasAttribute("aria-controls")) return;
  if (event instanceof KeyboardEvent && control instanceof HTMLButtonElement) return;

  // Bubbling runs after the local toggle, but before Vue patches the layout.
  const top = control.getBoundingClientRect().top;
  follow.value = false;
  await nextTick();
  if (transcript.value === viewport && viewport.contains(control)) {
    viewport.scrollTop += control.getBoundingClientRect().top - top;
    updateJumpPill(viewport);
  }
}

function onTranscriptKeydown(event: KeyboardEvent) {
  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) follow.value = false;
  if (event.key === "Enter" || event.key === " ") void onTranscriptDisclosure(event);
}

function onTranscriptScroll(event: Event) {
  const el = event.target as HTMLElement | null;
  if (!el) return;
  const distance = distanceToLatest(el);
  const selection = document.getSelection();
  const selecting = selection && !selection.isCollapsed && el.contains(selection.anchorNode);
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 1 && !selecting) follow.value = true;
  else if (distance >= 80) follow.value = false;
  updateJumpPill(el);
  if (el.scrollTop < 120 && hasOlderMessages.value) {
    void loadOlderMessages();
  }
}

function updateJumpPill(el: HTMLElement) {
  const distance = distanceToLatest(el);
  if (distance > 180) showJumpPill.value = true;
  else if (distance <= 80) showJumpPill.value = false;
}

function scrollToBottom() {
  follow.value = true;
  showJumpPill.value = false;
  if (transcript.value) {
    transcript.value.scrollTop = transcript.value.scrollHeight;
    transcript.value.focus({ preventScroll: true });
  }
}

watch(activeChat, () => {
  olderRequest.value = undefined;
  visibleCount.value = PAGE_SIZE;
  follow.value = true;
  showJumpPill.value = false;
});

onBeforeUnmount(() => {
  clearQueueEdit();
  clearUploads(draftUploads.value);
  olderRequest.value = undefined;
});

watch(
  () => [
    current.value?.id,
    messages.value.length,
    messages.value.at(-1)?.id,
    messages.value.at(-1)?.text,
    pendingInputs.value.length,
    queuedInputs.value.length,
  ],
  async () => {
    const viewport = transcript.value;
    const content = messageFlow.value;
    if (!follow.value || loadingOlder.value || !viewport || !content) return;
    hasTranscriptOverflow.value = content.getBoundingClientRect().height > viewport.clientHeight;
    await nextTick();
    if (follow.value && !loadingOlder.value && transcript.value === viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  },
  { flush: "post" },
);
</script>

<template>
  <section
    class="chat-panel panel-fill"
    aria-label="Conversation"
    @dragover="$event.dataTransfer?.types.includes('Files') && $event.preventDefault()"
    @drop="current ? drop($event) : $event.preventDefault()"
  >
    <ContextMenu ref="messageMenu" v-model:open="messageMenuOpen" label="Message actions" :groups="messageMenuGroups"
      :on-error="() => notifications.notify('The menu action could not be completed')" />
    <ChatMessageSlot.Contribute v-slot="{ message, Next }">
      <RunStopMessageView
        v-if="isRunStopMessage(message.source)"
        :message="message.source"
      />
      <component :is="Next" v-else />
    </ChatMessageSlot.Contribute>
    <ChatMessageSlot.Contribute v-slot="{ message, Next }">
      <UserMessageView
        v-if="message.role === 'user'"
        :message="message"
        :on-edit="editingItemId === null ? editUserMessage : undefined"
      />
      <component :is="Next" v-else />
    </ChatMessageSlot.Contribute>
    <ChatMessageSlot.Contribute v-slot="{ message, Next }">
      <AssistantMessageView
        v-if="message.role === 'assistant' && !message.source"
        :message="message"
      />
      <component :is="Next" v-else />
    </ChatMessageSlot.Contribute>
    <header v-if="current" class="chat-heading">
      <h1>{{ current.title || "New conversation" }}</h1>
    </header>

    <div v-if="!current" class="chat-empty">
      <h1>Start a conversation</h1>
      <p>Ask a question or give Harness a task.</p>
      <Button variant="primary" @click="startConversation">New conversation</Button>
    </div>
    <div v-else class="transcript-viewport">
      <div
        ref="transcript"
        class="transcript"
        :class="{ 'has-overflow': hasTranscriptOverflow }"
        role="region"
        aria-label="Messages"
        tabindex="0"
        @scroll="onTranscriptScroll"
        @pointerdown.capture="rememberMessageMenuFocus"
        @click="onTranscriptDisclosure"
        @wheel.passive="$event.deltaY < 0 && (follow = false)"
        @contextmenu="openMessageMenu(undefined, $event)"
        @keydown="openMessageMenu(undefined, $event); onTranscriptKeydown($event)"
      >
        <div ref="messageFlow" class="message-flow">
          <div v-if="hasOlderMessages" class="flex justify-center py-2">
            <button
              type="button"
              class="work-pill"
              :disabled="loadingOlder"
              @click="loadOlderMessages"
            >
              {{ loadingOlder ? "Loading earlier messages…" : "Load earlier messages" }}
            </button>
          </div>
          <article
            v-for="message in visibleMessages"
            :key="message.id"
            class="chat-row"
            tabindex="-1"
            @contextmenu="openMessageMenu(message, $event)"
            @keydown.capture="openMessageMenu(message, $event)"
            :class="message.role"
          >
            <ChatMessageSlot :message="message" />
          </article>
        </div>
      </div>

      <Transition name="jump-pill">
        <button v-if="showJumpPill" type="button" class="jump-pill" @click="scrollToBottom">
          <span class="i-codicon-arrow-down" aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      </Transition>
    </div>

    <div v-if="current" class="composer-area">
      <div v-if="chatNotice" class="chat-notice" role="status">
        <span class="i-codicon-info chat-notice-icon" aria-hidden="true" />
        <span class="chat-notice-text">{{ chatNotice }}</span>
        <button
          type="button"
          class="chat-notice-dismiss"
          aria-label="Dismiss notice"
          @click="if (activeChat) activeChat.notice.value = '';"
        >
          <span class="i-codicon-close" aria-hidden="true" />
        </button>
      </div>
      <div
        v-if="totalQueuedCount > 0"
        class="pending-queue"
        role="region"
        aria-label="Queued messages"
      >
        <div
          ref="queueList"
          class="pending-queue-list"
          @pointerdown.capture="rememberMessageMenuFocus"
          :class="{ 'is-dragging': dragState !== null }"
        >
          <div
            v-for="entry in flatQueueItems"
            :key="entry.item.id"
            class="pending-item"
            @contextmenu="openMessageMenu(undefined, $event, entry.item.id)"
            @keydown.capture="openMessageMenu(undefined, $event, entry.item.id)"
            :class="{
              'is-pending-turn': entry.target === 'pending',
              'is-queued-turn': entry.target === 'queue',
              'is-nested':
                dragState?.fromFlat === entry.flatIndex
                  ? dragState.targetDepth === 1
                  : entry.depth === 1,
              editing: editingItemId === entry.item.id,
              dragging: dragState?.fromFlat === entry.flatIndex,
              reordering: dragState !== null && dragState.fromFlat !== entry.flatIndex,
            }"
            :style="getItemDragStyle(entry.flatIndex)"
          >
            <span
              class="pending-grip"
              title="Drag to reorder or adjust turn level"
              @pointerdown="onGripPointerDown(entry.flatIndex, $event)"
            >
              <span
                class="pending-grip-default"
                :class="entry.depth === 1 ? 'i-codicon-circle-small-filled' : 'i-codicon-indent'"
              />
              <span class="i-codicon-gripper pending-grip-hover" />
            </span>
            <div class="pending-body">
              <span v-if="getPendingImages(entry.item).length" class="pending-images">
                <button
                  v-for="(image, imgIndex) in getPendingImages(entry.item)"
                  :key="`${image.fileId ?? image.url}:${imgIndex}`"
                  type="button"
                  class="pending-image-thumb"
                  :title="image.filename ?? 'View image'"
                  @click.stop="openImageBlocksLightbox(getPendingImages(entry.item), imgIndex)"
                >
                  <img :src="imageSrc(image)" :alt="image.filename ?? 'Queued image'" />
                </button>
              </span>
              <button
                type="button"
                class="pending-message"
                :aria-current="editingItemId === entry.item.id ? 'true' : undefined"
                :disabled="editingItemId !== null && Boolean(attachmentStatus)"
                @click="startEditing(entry.item)"
              >
                <span class="sr-only">
                  Edit {{ entry.target === "pending" ? "pending input" : "queued message" }}
                  {{ entry.index + 1 }}:
                </span>
                <span class="pending-text">{{
                  getPendingText(entry.item) ||
                  (getPendingImages(entry.item).length ? "Image attachment" : "Empty message")
                }}</span>
                <span
                  v-if="editingItemId === entry.item.id"
                  class="editing-badge"
                  aria-hidden="true"
                  >Editing</span
                >
              </button>
            </div>
            <div class="pending-item-actions">
              <IconButton
                icon="i-codicon-trash"
                :label="
                  entry.target === 'pending'
                    ? `Remove pending input ${entry.index + 1}`
                    : `Remove queued message ${entry.index + 1}`
                "
                @click="
                  (entry.target === 'pending' ? pendingInputs : queuedInputs).splice(entry.index, 1)
                "
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="!isPresetLocked" class="preset-selector">
        <DropdownMenuRoot
          v-model:open="presetMenuOpen"
          :modal="false"
          @update:open="
            (open: boolean) => {
              if (open) void activeChat?.refreshChoices();
            }
          "
        >
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="menu-trigger preset-trigger"
              aria-label="Select agent preset"
              :title="selectedPreset?.name ?? 'No agent presets available'"
            >
              <span ref="presetTriggerIcon" class="inline-flex shrink-0" aria-hidden="true">
                <PresetIcon :icon="selectedPreset?.icon" />
              </span>
              <span class="preset-trigger-name">{{ selectedPreset?.name ?? "No preset" }}</span>
              <span class="i-codicon-chevron-down shrink-0" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              class="popup-menu preset-menu"
              aria-label="Agent presets"
              aria-labelledby=""
              side="top"
              align="start"
              :side-offset="5"
              :collision-padding="8"
            >
              <DropdownMenuRadioGroup v-model="presetId">
                <DropdownMenuRadioItem
                  v-for="item in presets"
                  :key="item.id"
                  :value="item.id"
                  :text-value="item.name"
                  :aria-label="item.name"
                  :aria-description="item.description"
                  class="menu-item preset-item"
                >
                  <span class="preset-icon" aria-hidden="true">
                    <PresetIcon :icon="item.icon" />
                  </span>
                  <span class="preset-copy">
                    <span class="preset-name">{{ item.name }}</span>
                    <span v-if="item.description" class="preset-description">{{
                      item.description
                    }}</span>
                  </span>
                  <span class="preset-check" aria-hidden="true">
                    <DropdownMenuItemIndicator class="i-codicon-check" />
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuItem v-if="presets.length === 0" class="menu-item" disabled>
                No agent presets available
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>

      <form
        ref="composerForm"
        class="composer"
        :class="{
          'is-editing-item': editingItemId !== null,
          'is-drag-over': isDragOverComposer,
          'is-preset-moving': isPresetMoving,
        }"
        @submit.prevent="onFormSubmit"
        @dragenter="onComposerDragEnter"
        @dragover="onComposerDragOver"
        @dragleave="onComposerDragLeave"
        @drop.stop="drop"
      >
        <div
          v-if="composerImages.length"
          class="composer-images"
          role="list"
          aria-label="Attached images"
        >
          <div
            v-for="(image, index) in composerImages"
            :key="image.localId"
            class="composer-image-item"
            :class="`is-${image.status}`"
            role="listitem"
          >
            <button
              type="button"
              class="composer-image-preview"
              :title="image.error ?? image.filename ?? 'Preview image'"
              @click="openComposerLightbox(index)"
            >
              <img :src="composerPreviewSrc(image)" :alt="image.filename ?? 'Attached image'" />
            </button>
            <div
              v-if="image.status === 'uploading'"
              class="composer-image-overlay"
              aria-label="Uploading"
            >
              <span class="i-codicon-loading composer-image-spinner" />
            </div>
            <button
              v-else-if="image.status === 'error'"
              type="button"
              class="composer-image-retry"
              :title="image.error ? `Retry upload: ${image.error}` : 'Retry upload'"
              aria-label="Retry image upload"
              @click.stop="uploadComposerImage(image)"
            >
              <span class="i-codicon-refresh" />
            </button>
            <button
              type="button"
              class="composer-image-remove"
              :aria-label="`Remove ${image.filename ?? 'image'}`"
              @click.stop="removeComposerImage(image)"
            >
              <span class="i-codicon-close" />
            </button>
          </div>
        </div>
        <p v-if="attachmentStatus" :id="attachmentStatusId" class="attachment-status" role="status">
          {{ attachmentStatus }}
        </p>
        <ChatInputNotificationSlot :session-id="current?.id" />
        <textarea
          v-if="current"
          ref="messageInput"
          v-model="draft"
          aria-label="Message Harness"
          :aria-describedby="attachmentStatus ? attachmentStatusId : undefined"
          :placeholder="
            editingItemId !== null
              ? 'Edit message…'
              : isSessionRunning
                ? 'Write a follow-up…'
                : 'Message Harness…'
          "
          @keydown="onComposerKeydown"
          @paste="onComposerPaste"
        />
        <div ref="composerToolbar" class="composer-toolbar">
          <TooltipProvider
            v-if="isPresetLocked && selectedPreset"
            :delay-duration="400"
          >
            <TooltipRoot :key="current?.id">
              <TooltipTrigger as-child>
                <span
                  ref="composerPresetIcon"
                  class="composer-preset-icon"
                  role="img"
                  tabindex="0"
                  :aria-label="`Agent preset: ${selectedPreset.name}`"
                >
                  <PresetIcon :icon="selectedPreset.icon" />
                </span>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  class="popup-menu preset-hover"
                  side="top"
                  align="start"
                  :side-offset="8"
                  :collision-padding="8"
                >
                  <span class="preset-icon" aria-hidden="true">
                    <PresetIcon :icon="selectedPreset.icon" />
                  </span>
                  <span class="preset-copy">
                    <span class="preset-name">{{ selectedPreset.name }}</span>
                    <span v-if="selectedPreset.description" class="preset-description">{{
                      selectedPreset.description
                    }}</span>
                  </span>
                </TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
          </TooltipProvider>
          <span
            v-if="isPresetLocked && selectedPreset"
            class="composer-preset-separator"
            aria-hidden="true"
            >x</span
          >
          <ActionMenu
            label="Select model"
            @update:open="
              (open: boolean) => {
                if (open) {
                  void chatManager.refreshModels();
                  void activeChat?.refreshChoices();
                }
              }
            "
            side="top"
            align="start"
            :groups="modelMenu.resolve(undefined)"
          >
            <span class="composer-model-name">{{ model?.name ?? "No model" }}</span>
            <span class="i-codicon-chevron-down shrink-0" aria-hidden="true" />
          </ActionMenu>
          <span class="spacer" />
          <ChatComposerSlot :session-id="current?.id" />
          <input
            ref="upload"
            class="hidden"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            @change="attach"
          />
          <IconButton icon="i-codicon-attach" label="Attach images" @click="upload?.click()" />
          <button
            v-if="isSessionRunning"
            class="send-button stop-btn"
            :class="{ 'primary-stop': stopIsPrimary }"
            type="button"
            aria-label="Stop response"
            title="Stop response"
            @click="stop"
          >
            <span class="i-codicon-debug-stop" aria-hidden="true" />
          </button>
          <button
            v-if="editingItemId !== null"
            class="done-edit-button"
            type="submit"
            :disabled="Boolean(attachmentStatus)"
            aria-label="Finish editing"
            title="Finish editing (Enter)"
          >
            Done
          </button>
          <button
            v-else-if="!stopIsPrimary"
            class="send-button primary"
            type="submit"
            :disabled="!canSend"
            :aria-label="sendAction.label"
            :title="`${sendAction.label} (Enter)`"
          >
            <svg
              v-if="sendAction.icon === 'queue'"
              width="1.05em"
              height="1.05em"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M2.5 3.1h11m-11 3.8h11M2.5 10.1v1a1.9 1.9 0 0 0 1.9 1.9h8.7m-2.4-2.4 2.4 2.4-2.4 2.4"
              />
            </svg>
            <span v-else :class="sendAction.icon" aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>

    <ImageLightbox
      :images="lightboxImages"
      :index="lightboxIndex"
      @close="closeLightbox"
      @update:index="lightboxIndex = $event"
    />
  </section>
</template>

<style scoped>
.preset-selector {
  display: flex;
  margin-bottom: 4px;
  min-width: 0;
}

.preset-trigger {
  min-width: 0;
  max-width: 100%;
}

.preset-trigger-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.preset-menu) {
  width: 288px;
  min-width: 0;
  max-width: calc(100vw - 16px);
  max-height: min(60vh, var(--reka-dropdown-menu-content-available-height));
}

:global(.popup-menu.preset-hover) {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 288px;
  min-width: 0;
  max-width: calc(100vw - 16px);
  padding: 12px;
}

.preset-item {
  height: auto;
  align-items: flex-start;
  padding: 8px;
}

.preset-icon,
.preset-check {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 18px;
}

.preset-copy {
  min-width: 0;
  flex: 1;
}

.preset-name,
.preset-description {
  display: block;
  overflow-wrap: anywhere;
  line-height: 18px;
}

.preset-description {
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
  line-height: 16px;
}

.preset-item[data-highlighted] .preset-description {
  color: inherit;
}

.pending-message {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  align-self: stretch;
  padding: 0;
  border-radius: 3px;
  text-align: left;
}

.composer textarea {
  field-sizing: content;
  height: auto;
  min-height: 60px;
  max-height: min(28cqh, 180px);
}

.attachment-status {
  margin: 4px 10px 0;
  color: var(--muted);
  font-size: 12px;
}

.composer.is-preset-moving {
  overflow: visible;
}

.composer-toolbar {
  gap: 4px;
}

.composer-toolbar > :deep(.menu-trigger) {
  min-width: 0;
}

.composer-preset-icon,
.composer-preset-separator,
.composer-preset-separator + :deep(.menu-trigger) {
  align-self: baseline;
}

.composer-preset-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: 7px;
  font-size: 12px;
}

.composer-preset-icon > :deep(.agent-preset-icon) {
  width: 12px;
  height: 12px;
}

.composer-preset-icon:focus-visible {
  outline: 1px solid var(--selection-border);
  outline-offset: 2px;
}

.composer-preset-separator {
  flex-shrink: 0;
  width: 6px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  opacity: 0.55;
  user-select: none;
}

.composer-preset-separator + :deep(.menu-trigger) {
  padding-left: 0;
}

@container (max-width: 480px) {
  .composer-preset-separator {
    font-size: 10px;
  }
}

.composer-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.send-button,
.done-edit-button {
  flex: none;
  margin-left: 0;
  transition: background-color 120ms ease;
}

.send-button:disabled,
.done-edit-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.send-button.stop-btn {
  background: transparent;
}

.send-button.stop-btn:hover,
.send-button.stop-btn.primary-stop {
  background: color-mix(in srgb, var(--red) 12%, transparent);
}

.send-button.stop-btn.primary-stop:hover {
  background: color-mix(in srgb, var(--red) 22%, transparent);
}

@media (hover: none), (pointer: coarse) {
  .pending-item-actions {
    opacity: 1;
    pointer-events: auto;
  }
}

.chat-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--warning-fg);
  background: color-mix(in srgb, var(--warning-fg) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning-fg) 28%, transparent);
}

.chat-notice-icon {
  flex: none;
}

.chat-notice-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.chat-notice-dismiss {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.75;
}

.chat-notice-dismiss:hover {
  opacity: 1;
}

.chat-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  text-align: center;
  color: var(--muted);
}

.chat-empty h1 {
  margin: 0;
  color: var(--strong);
  font-size: 18px;
  font-weight: 550;
}

.chat-empty p {
  margin: 0 0 8px;
}

.transcript:focus-visible {
  outline: 1px solid var(--selection-border);
  outline-offset: -1px;
}

@media (prefers-reduced-motion: reduce) {
  .jump-pill-enter-active,
  .jump-pill-leave-active {
    transition: none;
  }
}
</style>
