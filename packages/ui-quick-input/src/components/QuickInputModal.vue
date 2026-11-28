<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: QuickPick, QuickInputShell. Adaptation: native input and list navigation with Reka modal focus management. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { useService } from "@harness/ui-di";
import {
  UiQuickInputService,
  type InputValidation,
  type QuickInputRequest,
} from "@harness/ui-quick-input";

const quickInput = useService(UiQuickInputService);
const request = quickInput.activeRequest;
const field = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
const listId = useId();
const validationId = useId();
const query = ref("");
const inputValue = ref("");
const activeIndex = ref(0);
const validationMessage = ref<Exclude<InputValidation, string | undefined>>();
const picked = ref(new Set<number>());
let previousFocus: HTMLElement | undefined;
type InputRequest = Extract<QuickInputRequest, { kind: "input" }>;
let pending: { request: InputRequest; value: string; result: Promise<InputValidation> } | undefined;

watch(
  request,
  (req, previous) => {
    if (req && !previous && document.activeElement instanceof HTMLElement) {
      previousFocus = document.activeElement;
    }
    query.value = "";
    activeIndex.value = 0;
    validationMessage.value = undefined;
    pending = undefined;
    inputValue.value = req?.kind === "input" ? (req.options?.value ?? "") : "";
    picked.value = new Set(
      req?.kind === "pick" && req.multiple
        ? req.items.flatMap((item, index) => (item.picked ? [index] : []))
        : [],
    );
    if (req)
      void nextTick(() => {
        if (request.value !== req) return;
        field.value?.focus();
        field.value?.select();
      });
  },
  { immediate: true },
);

function closeAutoFocus(event: Event) {
  event.preventDefault();
  const target = previousFocus;
  const active = document.activeElement;
  const closing = event.target;
  if (active !== document.body && !(closing instanceof HTMLElement && closing.contains(active)))
    return;
  void nextTick(() => {
    if (!request.value && document.activeElement === document.body && target?.isConnected) {
      target.focus();
    }
  });
}

const filteredItems = computed(() => {
  const req = request.value;
  if (!req || req.kind !== "pick") return [];
  const q = query.value.trim().toLowerCase();
  const items = req.items.map((item, index) => ({ item, index }));
  if (!q) return items;
  return items.filter(
    ({ item }) =>
      item.label.toLowerCase().includes(q) ||
      ((req.options?.matchOnDescription ?? true) && item.description?.toLowerCase().includes(q)) ||
      (req.options?.matchOnDetail && item.detail?.toLowerCase().includes(q)),
  );
});
watch(filteredItems, () => {
  activeIndex.value = 0;
});

function move(event: KeyboardEvent, delta: number) {
  if (event.isComposing) return;
  event.preventDefault();
  const size = filteredItems.value.length;
  if (!size) return;
  activeIndex.value = (activeIndex.value + delta + size) % size;
  void nextTick(() => {
    list.value?.children[activeIndex.value]?.scrollIntoView({ block: "nearest" });
  });
}

function submitPick(event?: KeyboardEvent) {
  if (event?.isComposing) return;
  event?.preventDefault();
  const req = request.value;
  if (req?.kind !== "pick") return;
  if (req.multiple)
    quickInput.resolveActive(req.items.filter((_, index) => picked.value.has(index)));
  else if (filteredItems.value[activeIndex.value])
    quickInput.resolveActive(filteredItems.value[activeIndex.value]!.item);
}

async function validate(req: InputRequest, value: string): Promise<boolean> {
  if (!req.options?.validateInput) return true;
  if (pending?.request !== req || pending.value !== value) {
    const result = Promise.resolve()
      .then(() => req.options?.validateInput?.(value))
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    pending = { request: req, value, result };
  }
  const validation = pending;
  const result = await validation.result;
  if (pending !== validation || request.value !== req || inputValue.value !== value) return false;
  validationMessage.value =
    typeof result === "string"
      ? result
        ? { message: result, severity: "error" }
        : undefined
      : result;
  return validationMessage.value?.severity !== "error";
}

watch(inputValue, (value) => {
  const req = request.value;
  if (req?.kind === "input" && req.options?.validateOnChange) void validate(req, value);
});

async function submitInput(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  const req = request.value;
  if (req?.kind !== "input") return;
  const value = inputValue.value;
  const valid = await validate(req, value);
  if (valid && request.value === req && inputValue.value === value) quickInput.resolveActive(value);
}
</script>

<template>
  <DialogRoot
    :open="Boolean(request)"
    @update:open="
      (open) => {
        if (!open) quickInput.cancelActive();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="quick-input-backdrop" />
      <DialogContent
        v-if="request"
        class="quick-input-box"
        :aria-describedby="undefined"
        @open-auto-focus.prevent="field?.focus()"
        @close-auto-focus="closeAutoFocus"
        @escape-key-down="
          (event) => {
            if (event.isComposing) event.preventDefault();
          }
        "
      >
        <DialogTitle :class="request.options?.title ? 'quick-input-title' : 'sr-only'">
          {{ request.options?.title ?? (request.kind === "pick" ? "Select an item" : "Input") }}
        </DialogTitle>

        <template v-if="request.kind === 'pick'">
          <input
            ref="field"
            v-model="query"
            class="quick-input-field"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            :aria-controls="listId"
            :aria-label="request.options?.title ?? 'Select an item'"
            :aria-activedescendant="
              filteredItems[activeIndex]
                ? `${listId}-${filteredItems[activeIndex]!.index}`
                : undefined
            "
            :placeholder="request.options?.placeHolder ?? 'Type to filter'"
            autocomplete="off"
            spellcheck="false"
            @keydown.down="move($event, 1)"
            @keydown.up="move($event, -1)"
            @keydown.enter="submitPick"
          />
          <ul
            :id="listId"
            ref="list"
            class="quick-input-list"
            role="listbox"
            :aria-label="request.options?.title ?? 'Items'"
            :aria-multiselectable="request.multiple || undefined"
          >
            <li
              v-for="({ item, index }, position) in filteredItems"
              :id="`${listId}-${index}`"
              :key="index"
              role="option"
              :aria-selected="request.multiple ? picked.has(index) : position === activeIndex"
              class="quick-input-item"
              :class="{ active: position === activeIndex }"
              @mousemove="activeIndex = position"
              @click="!request.multiple && quickInput.resolveActive(item)"
            >
              <label class="quick-input-row">
                <input
                  v-if="request.multiple"
                  v-model="picked"
                  type="checkbox"
                  :value="index"
                  :aria-label="item.description ? `${item.label} ${item.description}` : item.label"
                />
                <span class="quick-input-text">
                  <span class="quick-input-line">
                    <span class="quick-input-label">{{ item.label }}</span>
                    <span v-if="item.description" class="quick-input-desc">{{
                      item.description
                    }}</span>
                  </span>
                  <span v-if="item.detail" class="quick-input-desc quick-input-detail">{{
                    item.detail
                  }}</span>
                </span>
              </label>
            </li>
          </ul>
          <p v-if="!filteredItems.length" class="quick-input-empty" role="status">
            No matching items
          </p>
          <div v-if="request.multiple" class="quick-input-actions">
            <button class="primary-button" type="button" @click="submitPick()">OK</button>
          </div>
        </template>

        <template v-else>
          <p v-if="request.options?.prompt" class="quick-input-prompt">
            {{ request.options.prompt }}
          </p>
          <input
            ref="field"
            v-model="inputValue"
            class="quick-input-field"
            :type="request.options?.password ? 'password' : 'text'"
            :aria-label="request.options?.title ?? request.options?.prompt ?? 'Input'"
            :aria-invalid="validationMessage?.severity === 'error' || undefined"
            :aria-describedby="validationMessage ? validationId : undefined"
            :placeholder="request.options?.placeHolder"
            @keydown.enter="submitInput"
          />
          <p
            v-if="validationMessage"
            :id="validationId"
            role="status"
            :class="
              validationMessage.severity === 'error' ? 'quick-input-error' : 'quick-input-prompt'
            "
          >
            {{ validationMessage.message }}
          </p>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.quick-input-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: transparent;
}

.quick-input-box {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1501;
  display: flex;
  flex-direction: column;
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 80px);
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--control-border);
  border-radius: 6px;
  padding: 10px;
  box-shadow: 0 8px 28px var(--shadow);
}

.quick-input-title {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 6px;
}

.quick-input-prompt,
.quick-input-empty {
  font-size: 12px;
  margin: 6px 0;
  color: var(--muted);
}

.quick-input-field {
  flex: none;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 13px;
}

.quick-input-list {
  min-height: 0;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
}

.quick-input-item {
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
}

.quick-input-item:hover {
  background: var(--hover);
}

.quick-input-item.active {
  background: var(--quick-input-focus-bg);
  color: var(--quick-input-focus-fg);
}

.quick-input-row,
.quick-input-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  cursor: inherit;
}

.quick-input-row > input {
  flex: none;
  margin: 0;
  align-self: center;
}

.quick-input-text {
  min-width: 0;
  flex: 1;
}

.quick-input-label,
.quick-input-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-input-desc {
  font-size: 12px;
  color: var(--muted);
}

.quick-input-detail {
  display: block;
  margin-top: 2px;
}

.quick-input-item.active .quick-input-desc {
  color: inherit;
}

.quick-input-actions {
  display: flex;
  flex: none;
  justify-content: flex-end;
  margin-top: 8px;
}

.quick-input-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--red);
}
</style>
