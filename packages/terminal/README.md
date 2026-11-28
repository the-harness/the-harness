# `@harness/terminal`

```ts
export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string | null | undefined>; // null removes an inherited variable.
  cols?: number;
  rows?: number;
  title?: string;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
  createdAt: number;
  isInteractedWith: boolean; // True after data is sent to the PTY.
}

export interface TerminalListener {
  // 可拓展接口：消费真实 PTY 事件和终端移除事件。
  onData(data: string): void;
  onExit?(exitCode: number): void;
  onClose?(): void; // Fires when the terminal is removed from the inventory.
  onResize?(cols: number, rows: number): void;
  onStateChange?(state: { isInteractedWith: boolean }): void;
}

export class TerminalService {
  list(): TerminalInfo[];
  get(id: string): TerminalInfo | undefined;
  create(options?: CreateTerminalOptions): Promise<TerminalInfo>;
  attach(id: string, listener: TerminalListener): TerminalAttachment | undefined;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): boolean;
  dispose(): void;
}
```
