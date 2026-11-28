<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{
  terminalId: string;
  active: boolean;
}>();

const emit = defineEmits<{
  exited: [exitCode: number];
  contextmenu: [event: MouseEvent | KeyboardEvent];
}>();

const containerRef = ref<HTMLElement>();
const searchVisible = ref(false);
const searchQuery = ref("");
const searchInputRef = ref<HTMLInputElement>();

let term: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let searchAddon: SearchAddon | undefined;
let webglAddon: WebglAddon | undefined;
let ws: WebSocket | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let reconnectTimer: number | undefined;
let fitRaf: number | undefined;
let disposed = false;

function readFontFamily(): string {
  const styles = getComputedStyle(document.documentElement);
  return (
    styles.getPropertyValue("--font-mono").trim() ||
    'Menlo, Monaco, "Courier New", ui-monospace, SFMono-Regular, monospace'
  );
}

function readTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const bg = get("--bg", "#1e1e1e");
  const fg = get("--fg", "#cccccc");
  const accent = get("--accent", "#007acc");
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: `${accent}44`,
    black: "#1e1e1e",
    red: "#f44747",
    green: "#6a9955",
    yellow: "#d7ba7d",
    blue: "#569cd6",
    magenta: "#c586c0",
    cyan: "#4ec9b0",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#f44747",
    brightGreen: "#6a9955",
    brightYellow: "#d7ba7d",
    brightBlue: "#569cd6",
    brightMagenta: "#c586c0",
    brightCyan: "#4ec9b0",
    brightWhite: "#ffffff",
  };
}

function sendJson(payload: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function scheduleFit(): void {
  if (!props.active || !fitAddon || !term) return;
  if (fitRaf !== undefined) cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    fitRaf = undefined;
    if (!props.active || !fitAddon || !term) return;
    const prevCols = term.cols;
    const prevRows = term.rows;
    fitAddon.fit();
    if (term.cols !== prevCols || term.rows !== prevRows) {
      sendJson({ type: "resize", cols: term.cols, rows: term.rows });
    }
  });
}

function connect(): void {
  if (disposed) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${location.host}/ws/terminals/${encodeURIComponent(props.terminalId)}`,
  );
  ws = socket;

  socket.addEventListener("open", () => {
    scheduleFit();
  });

  socket.addEventListener("message", (event) => {
    if (!term) return;
    try {
      const msg = JSON.parse(String(event.data)) as
        | {
            type: "snapshot";
            info: { cols: number; rows: number; exited: boolean; exitCode: number | null };
            data: string;
          }
        | { type: "data"; data: string }
        | { type: "resize"; cols: number; rows: number }
        | { type: "exit"; exitCode: number }
        | { type: "error"; message: string };

      if (msg.type === "snapshot") {
        term.reset();
        if (msg.info.cols > 0 && msg.info.rows > 0) {
          term.resize(msg.info.cols, msg.info.rows);
        }
        if (msg.data) {
          term.write(msg.data);
        }
        if (msg.info.exited) {
          emit("exited", msg.info.exitCode ?? 0);
        }
        scheduleFit();
      } else if (msg.type === "data") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        if (msg.cols !== term.cols || msg.rows !== term.rows) {
          term.resize(msg.cols, msg.rows);
        }
      } else if (msg.type === "exit") {
        term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
        emit("exited", msg.exitCode);
      }
    } catch {
      // Ignore malformed server message
    }
  });

  socket.addEventListener("close", (event) => {
    if (disposed || event.code === 1008) return;
    reconnectTimer = window.setTimeout(() => {
      connect();
    }, 1000);
  });
}

onMounted(() => {
  const el = containerRef.value;
  if (!el) return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.35,
    fontFamily: readFontFamily(),
    theme: readTheme(),
    scrollback: 5000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new ClipboardAddon());
  term.loadAddon(searchAddon);

  term.open(el);

  try {
    webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon?.dispose();
      webglAddon = undefined;
    });
    term.loadAddon(webglAddon);
  } catch {
    // Fallback to canvas/dom renderer
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const isMod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (isMod && key === "c" && term?.hasSelection()) {
      const selection = term.getSelection();
      if (selection) {
        void navigator.clipboard.writeText(selection);
      }
      return false;
    }

    if (isMod && key === "v") {
      void navigator.clipboard.readText().then((text) => {
        if (text) term?.paste(text);
      });
      return false;
    }

    if (isMod && key === "k") {
      event.preventDefault();
      event.stopPropagation();
      term?.clear();
      return false;
    }

    if (isMod && key === "f") {
      openSearch();
      return false;
    }

    if (event.metaKey && event.key === "Backspace") {
      sendJson({ type: "input", data: "\x15" });
      return false;
    }

    return true;
  });

  term.onData((data) => {
    sendJson({ type: "input", data });
  });

  resizeObserver = new ResizeObserver(() => {
    scheduleFit();
  });
  resizeObserver.observe(el);

  themeObserver = new MutationObserver(() => {
    if (term) {
      term.options.theme = readTheme();
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });

  connect();
  if (props.active) {
    scheduleFit();
  }
});

watch(
  () => props.active,
  (active) => {
    if (active) {
      scheduleFit();
    }
  },
);

function openSearch(): void {
  searchVisible.value = true;
  requestAnimationFrame(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
}

function closeSearch(): void {
  searchVisible.value = false;
  searchAddon?.clearDecorations();
  term?.focus();
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  closeSearch();
}

function findNext(): void {
  if (searchQuery.value) {
    searchAddon?.findNext(searchQuery.value);
  }
}

function findPrevious(): void {
  if (searchQuery.value) {
    searchAddon?.findPrevious(searchQuery.value);
  }
}

function onContextMenu(event: MouseEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229 ||
    (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))) return;
  emit("contextmenu", event);
}

defineExpose({
  input: () => term?.textarea,
  selection: () => term?.getSelection() ?? "",
  selectAll: () => term?.selectAll(),
  paste: (text: string) => { if (!disposed) term?.paste(text); },
  clear: () => term?.clear(),
  openSearch,
  focus: () => (searchInputRef.value ?? term)?.focus(),
});

onBeforeUnmount(() => {
  disposed = true;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  if (fitRaf !== undefined) cancelAnimationFrame(fitRaf);
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  ws?.close();
  webglAddon?.dispose();
  term?.dispose();
});
</script>

<template>
  <div v-show="active" class="relative h-full w-full overflow-hidden">
    <div
      v-if="searchVisible"
      role="search"
      aria-label="Terminal search"
      @keydown.stop="onSearchKeydown"
      @contextmenu.stop
      class="absolute right-3 top-2 z-10 flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs shadow-md"
    >
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        type="text"
        placeholder="Find"
        class="w-40 bg-transparent text-[var(--fg)] outline-none"
        @keydown.enter.exact.prevent="findNext"
        @keydown.enter.shift.prevent="findPrevious"
      />
      <button
        type="button"
        class="px-1 hover:text-[var(--accent)]"
        title="Previous Match"
        aria-label="Previous Match"
        @click="findPrevious"
      >
        ↑
      </button>
      <button
        type="button"
        class="px-1 hover:text-[var(--accent)]"
        title="Next Match"
        aria-label="Next Match"
        @click="findNext"
      >
        ↓
      </button>
      <button
        type="button"
        class="px-1 hover:text-[var(--red,#f44747)]"
        title="Close"
        aria-label="Close terminal search"
        @click="closeSearch"
      >
        ×
      </button>
    </div>
    <div ref="containerRef" class="h-full w-full overflow-hidden p-1.5"
      @contextmenu.capture="onContextMenu" @keydown.capture="onContextMenu" />
  </div>
</template>
