# `@harness/ui-terminal`

```ts
export interface TerminalMenuContext {
  readonly terminal?: TerminalTab;
  readonly area: "content" | "tab" | "panel";
  readonly selection: string;
  readonly instance?: {
    paste(text: string): void;
    selectAll(): void;
    openSearch(): void;
    clear(): void;
  };
  readonly showTabs: boolean;
  readonly create: () => Promise<void>;
  readonly focus: () => void;
  readonly kill: () => Promise<void>;
  readonly toggleTabs: () => void;
}

export class UiTerminalService {
  readonly menu: Menu<TerminalMenuContext, "navigation" | "clipboard" | "buffer" | "terminate" | "view">; // Scoped terminal menu contributions.
  readonly terminals: TerminalTab[];
  readonly activeId: Ref<string | null>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | null>;
  observe(
    id: string,
    listener: {
      onData(data: string): void;
      onExit(exitCode?: number): void;
      onClose?(): void; // Fires when a running terminal is removed.
      onStateChange?(state: { isInteractedWith: boolean }): void;
      onError?(error: Error): void;
    },
  ): { dispose(): void }; // Observes the real PTY even without a mounted terminal panel.
  onDidExit(listener: (event: { id: string; exitCode?: number }) => void): { dispose(): void };
  refresh(): Promise<void>;
  ensureDefaultTerminal(): Promise<void>; // Joins automatic creation while the inventory is empty.
  create(options?: {
    cwd?: string;
    env?: Record<string, string | null>;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    title?: string;
  }): Promise<TerminalTab | null>;
  kill(id: string): Promise<void>;
  select(id: string): void;
  useWriter(id: string, writer: (data: string) => void): void;
  write(id: string, data: string): Promise<void>; // Sends actual PTY input with or without a mounted terminal panel.
  markExited(id: string, exitCode: number): void;
}
```
