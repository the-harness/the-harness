<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: QuickPick, QuickInputShell, HighlightedLabel, KeybindingLabel. Adaptation: editable Quick Access prefixes, Reka focus management, and isolated keycap styles with equal single-key widths. -->
<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->
<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "reka-ui";
import type { QuickAccessItem } from "../quickAccess.ts";
const open = defineModel<boolean>({ default: false });
const query = defineModel<string>("query", { default: ">" });
const props = withDefaults(defineProps<{
  commands: QuickAccessItem[];
  search?: string;
  label?: string;
  placeholder?: string;
  emptyText?: string;
  loading?: boolean;
  hint?: string;
}>(), {
  label: "Search commands",
  placeholder: "Type the name of a command to run.",
  emptyText: "No matching commands.",
});
const emit = defineEmits<{ accept: [] }>();
const input = ref<HTMLInputElement>();
// A retired selection stays clear until the user navigates or changes the search.
const selectedId = ref<string | null>();
const list = ref<HTMLElement>();
let previousFocus: HTMLElement | undefined;
let pendingCommand: QuickAccessItem | undefined;

interface MatchedPart {
  text: string;
  highlight: boolean;
}

function matchCommand(
  title: string,
  search: string,
): { parts: MatchedPart[]; score: number } | null {
  if (!search) return { parts: [{ text: title, highlight: false }], score: 0 };
  const lowerTitle = title.toLowerCase();
  const lowerSearch = search.toLowerCase();
  const contiguous = lowerTitle.indexOf(lowerSearch);
  if (contiguous !== -1) {
    const parts: MatchedPart[] = [];
    if (contiguous > 0) parts.push({ text: title.slice(0, contiguous), highlight: false });
    parts.push({
      text: title.slice(contiguous, contiguous + search.length),
      highlight: true,
    });
    if (contiguous + search.length < title.length) {
      parts.push({ text: title.slice(contiguous + search.length), highlight: false });
    }
    return { parts, score: contiguous === 0 ? 3 : 2 };
  }
  const indices: number[] = [];
  let cursor = 0;
  for (let i = 0; i < lowerSearch.length; i++) {
    const ch = lowerSearch[i]!;
    const found = lowerTitle.indexOf(ch, cursor);
    if (found === -1) return null;
    indices.push(found);
    cursor = found + 1;
  }
  const parts: MatchedPart[] = [];
  let pos = 0;
  for (const idx of indices) {
    if (idx > pos) parts.push({ text: title.slice(pos, idx), highlight: false });
    const prev = parts.at(-1);
    if (prev?.highlight) prev.text += title[idx]!;
    else parts.push({ text: title[idx]!, highlight: true });
    pos = idx + 1;
  }
  if (pos < title.length) parts.push({ text: title.slice(pos), highlight: false });
  return { parts, score: 1 };
}

const results = computed(() => {
  const cleaned = props.search ?? query.value.replace(/^>/, "").trim();
  const matched = props.commands
    .map((command) => {
      const match = matchCommand(command.title, cleaned);
      if (match) return { command, parts: match.parts, score: match.score };
      const pathMatch = command.searchText && matchCommand(command.searchText, cleaned);
      return pathMatch ? { command, parts: [{ text: command.title, highlight: false }], score: 0 } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (cleaned) matched.sort((a, b) => b.score - a.score);
  return matched;
});

const selected = computed(() =>
  results.value.findIndex(({ command }) => command.id === selectedId.value),
);

function selectFirstResult() {
  selectedId.value = results.value[0]?.command.id;
}

watch(
  results,
  (entries) => {
    const id = selectedId.value;
    if (id === undefined) selectFirstResult();
    else if (id !== null && !entries.some(({ command }) => command.id === id)) {
      selectedId.value = props.loading ? undefined : null;
    }
  },
  { immediate: true },
);

watch(open, (value) => {
  if (value && document.activeElement instanceof HTMLElement) {
    previousFocus = document.activeElement;
  }
  if (value) selectFirstResult();
});
watch(query, () => {
  selectedId.value = undefined;
  selectFirstResult();
  if (list.value) list.value.scrollTop = 0;
});
watch(() => results.value[selected.value]?.command, (command) => {
  if (open.value) command?.preview?.();
});
function focusInput() {
  input.value?.focus();
  const prefixLength = /^[>@:?]/.test(query.value) ? 1 : 0;
  input.value?.setSelectionRange(prefixLength, query.value.length);
}
function run(command?: QuickAccessItem) {
  if (!command) return;
  if (command.prefix !== undefined) {
    query.value = command.prefix;
    void nextTick(focusInput);
    return;
  }
  emit("accept");
  pendingCommand = command;
  open.value = false;
}
function closeAutoFocus(event: Event) {
  const command = pendingCommand;
  pendingCommand = undefined;
  event.preventDefault();
  const closing = event.target;
  void nextTick(() => {
    const active = document.activeElement;
    if (
      (active === document.body || (closing instanceof HTMLElement && closing.contains(active))) &&
      previousFocus?.isConnected
    ) {
      previousFocus.focus({ preventScroll: true });
    }
    command?.run();
  });
}
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  switch (event.key) {
    case "ArrowDown":
      move(1);
      break;
    case "ArrowUp":
      move(-1);
      break;
    case "PageDown":
      moveTo(selected.value + 8);
      break;
    case "PageUp":
      moveTo(selected.value - 8);
      break;
    case "Enter":
      run(results.value[selected.value]?.command);
      break;
    default:
      return;
  }
  event.preventDefault();
}
function move(delta: number) {
  const size = results.value.length;
  if (!size) return;
  const index = selected.value;
  moveTo(index === -1 ? (delta > 0 ? 0 : size - 1) : (index + delta + size) % size);
}
function moveTo(index: number) {
  const entries = results.value;
  const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
  if (!entry) return;
  selectedId.value = entry.command.id;
  void nextTick(() => {
    list.value?.querySelector<HTMLElement>(`#command-${selected.value}`)?.scrollIntoView({
      block: "nearest",
    });
  });
}
function shortcutKeys(shortcut?: string) {
  return shortcut ? shortcut.split(/\s+/).filter(Boolean) : [];
}
</script>
<template>
  <DialogRoot v-model:open="open"
    ><DialogPortal
      ><DialogOverlay class="dialog-overlay" /><DialogContent
        class="command-palette"
        @close-auto-focus="closeAutoFocus"
        @open-auto-focus="(event) => { event.preventDefault(); focusInput(); }"
        @escape-key-down="
          (event) => {
            if (event.isComposing) event.preventDefault();
          }
        "
        ><DialogTitle class="sr-only">Quick Access</DialogTitle
        ><DialogDescription class="sr-only"
          >Search files and commands, or type @ for symbols, : for a line, and ? for help. Use arrow keys to select and Enter to open.</DialogDescription
        >
        <div class="command-input">
          <input
            ref="input"
            v-model="query"
            :aria-label="label"
            :placeholder="placeholder"
            role="combobox"
            aria-expanded="true"
            aria-controls="commands"
            :aria-activedescendant="results[selected] ? `command-${selected}` : undefined"
            spellcheck="false"
            autocomplete="off"
            @keydown="onKeydown"
          />
        </div>
        <div id="commands" ref="list" class="command-results" role="listbox" :aria-label="label" :aria-busy="loading">
          <button
            v-for="(entry, index) in results"
            :id="`command-${index}`"
            :key="entry.command.id"
            type="button"
            role="option"
            :aria-selected="index === selected"
            :class="{ selected: index === selected, 'command-help': entry.command.prefix !== undefined }"
            @mousemove="selectedId = entry.command.id"
            @click="run(entry.command)"
          >
            <span v-if="entry.command.icon" :class="entry.command.icon" aria-hidden="true" /><span class="command-label"
              ><template v-for="(part, partIndex) in entry.parts" :key="partIndex"
                ><span v-if="part.highlight" class="highlight">{{ part.text }}</span
                ><template v-else>{{ part.text }}</template></template
              ></span
            ><span v-if="entry.command.description" class="command-description">{{ entry.command.description }}</span
            ><span class="spacer" /><span
              v-if="entry.command.shortcut"
              class="command-keybinding"
              :aria-label="entry.command.shortcut"
              ><span
                v-for="(key, keyIndex) in shortcutKeys(entry.command.shortcut)"
                :key="keyIndex"
                class="command-key"
                >{{ key }}</span
              ></span
            >
          </button>
          <p v-if="!results.length" class="empty-hint" role="status">{{ loading ? "Searching…" : emptyText }}</p>
          <p v-else-if="hint" class="empty-hint" role="status">{{ hint }}</p>
        </div>
      </DialogContent></DialogPortal
    ></DialogRoot
  >
</template>

<style scoped>
.command-input input {
  min-width: 0;
}
.command-help .command-label {
  width: 16px;
  text-align: center;
}
.command-help .command-description {
  color: inherit;
  font-size: 13px;
}
.command-description {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}
.command-results button.selected .command-description {
  color: inherit;
  opacity: 0.8;
}
.command-label {
  flex-shrink: 0;
  max-width: 75%;
}

.command-keybinding {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  color: inherit;
}
.command-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 22px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--control-border);
  border-radius: 3px;
  background: var(--hover);
  color: inherit;
  font-size: 11px;
  line-height: 14px;
}
.command-results button:is(.selected, :hover) .command-key {
  background: transparent;
  border-color: color-mix(in srgb, currentColor 30%, transparent);
}
</style>
