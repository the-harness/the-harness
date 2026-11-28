<!-- UI reference skill: vscode-ui; revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e; components: PanelTitle, List, IconButton. Adaptation: VS Code-style integrated terminal with top-right action bar and collapsible right-side terminal tabs list. -->
<script setup lang="ts">
import { computed, getCurrentScope, nextTick, onMounted, ref, shallowRef } from "vue";
import { UiTerminalService, type TerminalMenuContext } from "@harness/ui-terminal";
import { useService } from "@harness/ui-di";
import TerminalInstance from "./TerminalInstance.vue";
import { ContextMenu } from "@harness/ui-menu";

const terminal = useService(UiTerminalService);
const panelScope = getCurrentScope();
const panelRef = ref<HTMLElement>();
const showTabs = ref(true);
const newTerminalButton = ref<HTMLButtonElement>();
const instanceRefs = new Map<string, InstanceType<typeof TerminalInstance>>();
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuContext = shallowRef<Pick<TerminalMenuContext, "terminal" | "area" | "selection">>();
const menuGroups = computed(() => {
  const context = menuContext.value;
  if (!context || (context.terminal && !terminal.terminals.includes(context.terminal))) return [];
  const id = context.terminal?.id;
  return terminal.menu.resolve({
    ...context,
    instance: id ? instanceRefs.get(id) : undefined,
    showTabs: showTabs.value,
    create: createTerminal,
    focus: () => { if (id) selectTerminal(id); },
    kill: async () => { if (id) await killTerminal(id); },
    toggleTabs: () => { showTabs.value = !showTabs.value; },
  });
});

async function openMenu(terminalId: string | undefined, area: TerminalMenuContext["area"], event: MouseEvent | KeyboardEvent) {
  if (event.defaultPrevented || (event instanceof KeyboardEvent &&
    (event.isComposing || event.keyCode === 229 ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))))) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  menuContext.value = { terminal: terminal.terminals.find((item) => item.id === terminalId), area, selection: terminalId ? instanceRefs.get(terminalId)?.selection() ?? "" : "" };
  if (!menuGroups.value.length) return;
  event.preventDefault();
  event.stopPropagation();
  const returnFocus = area === "content"
    ? instanceRefs.get(terminalId!)?.input()
    : target.closest<HTMLElement>("button") ?? undefined;
  await nextTick();
  contextMenu.value?.show(event instanceof MouseEvent ? event : target, returnFocus);
}


function setInstanceRef(id: string, el: unknown): void {
  if (el) {
    instanceRefs.set(id, el as InstanceType<typeof TerminalInstance>);
  } else {
    instanceRefs.delete(id);
  }
}

function activeInstance() {
  const id = terminal.activeId.value;
  return id ? instanceRefs.get(id) : undefined;
}

async function focusAfterAction(control: Element | null) {
  await nextTick();
  const panel = panelRef.value;
  if (!panelScope?.active || !panel?.getClientRects().length || panel.closest("[inert]")) return;
  const group = panel.closest(".dv-groupview");
  if (group && !group.classList.contains("dv-active-group")) return;
  if (
    document.activeElement === control ||
    (control && !control.isConnected && document.activeElement === document.body)
  ) {
    activeInstance()?.focus();
  }
}

async function createTerminal() {
  const control = document.activeElement;
  await terminal.create();
  await focusAfterAction(control);
}

function selectTerminal(id: string) {
  const control = document.activeElement;
  terminal.select(id);
  void focusAfterAction(control);
}

async function killTerminal(id: string) {
  const control = document.activeElement;
  await terminal.kill(id);
  if (control && !control.isConnected && document.activeElement === document.body) {
    const instance = activeInstance();
    if (instance) instance.focus();
    else newTerminalButton.value?.focus();
  }
}

onMounted(async () => {
  const control = document.activeElement;
  await terminal.refresh();
  if (panelScope?.active) {
    await terminal.ensureDefaultTerminal();
    await focusAfterAction(control);
  }
});
</script>

<template>
  <section ref="panelRef" class="panel-fill flex h-full w-full flex-col overflow-hidden"
    @contextmenu="openMenu(undefined, 'panel', $event)"
    @keydown="openMenu(undefined, 'panel', $event)">
    <div
      class="flex h-7 shrink-0 items-center justify-between border-b border-[var(--border)] px-2"
    >
      <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--muted)]">
        <span class="i-codicon-terminal h-3.5 w-3.5 shrink-0" />
        <span class="truncate font-medium text-[var(--fg)]">
          {{
            terminal.terminals.find((t) => t.id === terminal.activeId.value)?.title ?? "Terminal"
          }}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          ref="newTerminalButton"
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          title="New Terminal"
          @click="createTerminal"
        >
          <span class="i-codicon-add h-3.5 w-3.5" />
        </button>
        <button
          v-if="terminal.activeId.value"
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          title="Find (Cmd/Ctrl+F)"
          @click="activeInstance()?.openSearch()"
        >
          <span class="i-codicon-search h-3.5 w-3.5" />
        </button>
        <button
          v-if="terminal.activeId.value"
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          title="Clear (Cmd/Ctrl+K)"
          @click="activeInstance()?.clear()"
        >
          <span class="i-codicon-clear-all h-3.5 w-3.5" />
        </button>
        <button
          v-if="terminal.activeId.value"
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--red)]"
          title="Kill Terminal"
          @click="killTerminal(terminal.activeId.value)"
        >
          <span class="i-codicon-trash h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          :class="{ 'bg-[var(--hover)] text-[var(--fg)]': showTabs }"
          title="Toggle Terminal Tabs"
          :aria-pressed="showTabs"
          @click="showTabs = !showTabs"
        >
          <span class="i-codicon-layout-sidebar-right h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          v-if="terminal.error.value"
          class="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[rgba(244,71,71,0.12)] px-2.5 py-1 text-xs text-[var(--red)]"
        >
          <span class="truncate">{{ terminal.error.value }}</span>
          <button
            type="button"
            class="ml-2 shrink-0 hover:opacity-80"
            aria-label="Dismiss terminal error"
            @click="terminal.error.value = null"
          >
            <span class="i-codicon-close block h-3.5 w-3.5" />
          </button>
        </div>

        <div class="relative min-h-0 flex-1 overflow-hidden">
          <TerminalInstance
            v-for="item in terminal.terminals"
            :key="item.id"
            :ref="(el) => setInstanceRef(item.id, el)"
            :terminal-id="item.id"
            :active="terminal.activeId.value === item.id"
            @exited="(code) => terminal.markExited(item.id, code)"
            @contextmenu="openMenu(item.id, 'content', $event)"
          />
          <div
            v-if="terminal.terminals.length === 0 && !terminal.loading.value"
            class="flex h-full items-center justify-center text-xs text-[var(--muted)]"
          >
            No active terminals
          </div>
        </div>
      </div>

      <aside
        v-if="showTabs"
        class="flex w-44 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--raised)] py-0.5 overflow-y-auto"
      >
        <div
          v-for="item in terminal.terminals"
          :key="item.id"
          @contextmenu="openMenu(item.id, 'tab', $event)"
          @keydown="openMenu(item.id, 'tab', $event)"
          role="group"
          :aria-label="item.title"
          class="group flex h-6 w-full items-center border-l-2 px-2 text-xs transition-colors"
          :class="
            terminal.activeId.value === item.id
              ? 'border-[var(--accent)] bg-[var(--active-selection)] text-[var(--fg)]'
              : 'border-transparent text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]'
          "
        >
          <button
            type="button"
            class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            :aria-pressed="terminal.activeId.value === item.id"
            @click="selectTerminal(item.id)"
          >
            <span class="i-codicon-terminal h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ item.title }}</span>
            <span v-if="item.exited" class="text-[10px] opacity-55">exited</span>
          </button>
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-80 group-focus-within:opacity-100 hover:bg-[var(--hover)] hover:text-[var(--red)]"
            aria-label="Kill Terminal"
            title="Kill Terminal"
            @click="killTerminal(item.id)"
          >
            <span class="i-codicon-trash h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </div>
    <ContextMenu ref="contextMenu" label="Terminal actions" :groups="menuGroups"
      :on-error="(error) => { terminal.error.value = error instanceof Error ? error.message : String(error); }" />
  </section>
</template>
