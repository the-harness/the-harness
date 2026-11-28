import { getCurrentScope, onScopeDispose, ref, shallowReactive } from "vue";
import { createTerminalMenu } from "./menus.ts";

export type { TerminalMenuContext } from "./menus.ts";

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
}

export class UiTerminalService {
  readonly menu = createTerminalMenu(this);
  private defaultCreation: Promise<void> | undefined;
  private readonly exitListeners = new Set<(event: { id: string; exitCode?: number }) => void>();
  readonly onDidExit = (listener: (event: { id: string; exitCode?: number }) => void) => {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  };
  observe(
    id: string,
    listener: {
      onData(data: string): void;
      onExit(exitCode?: number): void;
      onClose?(): void;
      onStateChange?(state: { isInteractedWith: boolean }): void;
      onError?(error: Error): void;
    },
  ): { dispose(): void } {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/ws/terminals/${encodeURIComponent(id)}`,
    );
    let ended = false;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        data?: string;
        exitCode?: number;
        message?: string;
        state?: { isInteractedWith: boolean };
        info?: { exited: boolean; exitCode: number | null; isInteractedWith?: boolean };
      };
      if (message.type === "state" && message.state) listener.onStateChange?.(message.state);
      if (message.type === "snapshot")
        listener.onStateChange?.({ isInteractedWith: message.info?.isInteractedWith ?? false });
      if (message.type === "data" || message.type === "snapshot") {
        if (message.data) listener.onData(message.data);
      }
      if (message.type === "removed") {
        if (ended) return;
        ended = true;
        listener.onClose?.();
      } else if (message.type === "exit" || (message.type === "snapshot" && message.info?.exited)) {
        if (ended) return;
        ended = true;
        const code =
          message.type === "exit" ? message.exitCode : (message.info?.exitCode ?? undefined);
        if (code !== undefined) this.markExited(id, code);
        listener.onExit(code);
      } else if (message.type === "error") listener.onError?.(new Error(message.message));
    });
    socket.addEventListener("error", () =>
      listener.onError?.(new Error(`Terminal stream failed: ${id}`)),
    );
    return {
      dispose() {
        socket.close();
      },
    };
  }
  readonly terminals: TerminalTab[] = shallowReactive([]);
  readonly activeId = ref<string | null>(null);
  readonly loading = ref(false);
  readonly error = ref<string | null>(null);

  async refresh(): Promise<void> {
    this.loading.value = true;
    try {
      const res = await fetch("/api/terminals");
      if (!res.ok) return;
      const list = (await res.json()) as TerminalTab[];
      this.terminals.splice(0, this.terminals.length, ...list);
      if (this.activeId.value && !list.some((item) => item.id === this.activeId.value)) {
        this.activeId.value = list[0]?.id ?? null;
      } else if (!this.activeId.value && list.length > 0) {
        this.activeId.value = list[0]!.id;
      }
    } finally {
      this.loading.value = false;
    }
  }

  async create(options?: {
    cwd?: string;
    env?: Record<string, string | null>;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    title?: string;
  }): Promise<TerminalTab | null> {
    this.error.value = null;
    const res = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options ?? {}),
    });
    if (!res.ok) {
      try {
        const body = (await res.json()) as { message?: string };
        this.error.value = body.message || `Failed to create terminal (${res.status})`;
      } catch {
        this.error.value = `Failed to create terminal (${res.status})`;
      }
      return null;
    }
    const created = (await res.json()) as TerminalTab;
    this.terminals.push(created);
    this.activeId.value = created.id;
    return created;
  }

  async kill(id: string): Promise<void> {
    await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
    const wasRunning = this.terminals.some((item) => item.id === id && !item.exited);
    const idx = this.terminals.findIndex((item) => item.id === id);
    if (idx !== -1) {
      this.terminals.splice(idx, 1);
    }
    if (this.activeId.value === id) {
      this.activeId.value =
        this.terminals[Math.max(0, idx - 1)]?.id ?? this.terminals[0]?.id ?? null;
    }
    if (wasRunning) for (const listener of this.exitListeners) listener({ id });
  }

  select(id: string): void {
    if (this.terminals.some((item) => item.id === id)) {
      this.activeId.value = id;
    }
  }

  ensureDefaultTerminal(): Promise<void> {
    if (this.defaultCreation) return this.defaultCreation;
    if (this.terminals.length > 0) return Promise.resolve();

    this.defaultCreation = Promise.resolve()
      .then(async () => {
        if (this.terminals.length === 0) await this.create();
      })
      .finally(() => {
        this.defaultCreation = undefined;
      });
    return this.defaultCreation;
  }

  private readonly writers = new Map<string, (data: string) => void>();

  useWriter(id: string, writer: (data: string) => void): void {
    if (!getCurrentScope()) {
      throw new Error("useWriter() requires an active EffectScope");
    }
    this.writers.set(id, writer);
    onScopeDispose(() => {
      if (this.writers.get(id) === writer) {
        this.writers.delete(id);
      }
    });
  }

  async write(id: string, data: string): Promise<void> {
    const writer = this.writers.get(id);
    if (writer) {
      writer(data);
      return;
    }
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!response.ok) throw new Error(`Terminal input failed: HTTP ${response.status}`);
  }

  markExited(id: string, exitCode: number): void {
    const index = this.terminals.findIndex((item) => item.id === id);
    const target = this.terminals[index];
    if (!target || target.exited) return;
    this.terminals[index] = { ...target, exited: true, exitCode };
    for (const listener of this.exitListeners) listener({ id, exitCode });
  }
}

export { default as TerminalInstance } from "./components/TerminalInstance.vue";
export { default as TerminalPanel } from "./components/TerminalPanel.vue";
export { useTerminalWorkbench } from "./workbench.ts";
