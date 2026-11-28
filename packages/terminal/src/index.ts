import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import xtermHeadless from "@xterm/headless";
import { getCurrentScope, onScopeDispose } from "reactivity";

const { Terminal: HeadlessTerminal } = xtermHeadless;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 500;
const SCROLLBACK_LINES = 5000;

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
  isInteractedWith: boolean;
}

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string | null | undefined>;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface TerminalSnapshot {
  info: TerminalInfo;
  data: string;
}

export interface TerminalListener {
  // 可拓展接口：消费真实 PTY 输出、状态变化和终端移除事件。
  onData: (data: string) => void;
  onExit?: (exitCode: number) => void;
  onClose?: () => void;
  onResize?: (cols: number, rows: number) => void;
  onStateChange?: (state: { isInteractedWith: boolean }) => void;
}

export interface TerminalAttachment {
  snapshot: TerminalSnapshot;
  detach: () => void;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

interface TerminalSession {
  info: TerminalInfo;
  pty: PtyProcess;
  headless: InstanceType<typeof HeadlessTerminal>;
  serializer: SerializeAddon;
  listeners: Set<TerminalListener>;
  disposables: Array<{ dispose(): void }>;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_DIMENSION, Math.floor(value)));
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("node-pty/package.json");
    const pkgDir = dirname(pkgPath);
    const candidates = [
      join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(pkgDir, "build", "Release", "spawn-helper"),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const stat = statSync(candidate);
      if ((stat.mode & 0o111) === 0) {
        chmodSync(candidate, stat.mode | 0o755);
      }
    }
  } catch {
    // Ignore if node-pty layout differs
  }
}

async function loadNodePty(): Promise<NodePtyModule> {
  const mod = await import("node-pty");
  ensureSpawnHelperExecutable();
  return (mod.default ?? mod) as unknown as NodePtyModule;
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  #nodePty: Promise<NodePtyModule> | undefined;

  constructor() {
    // Constructed outside DI, the owner calls dispose().
    if (getCurrentScope() !== undefined) onScopeDispose(() => this.dispose());
  }

  list(): TerminalInfo[] {
    return Array.from(this.sessions.values(), (session) => ({ ...session.info }));
  }

  get(id: string): TerminalInfo | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.info } : undefined;
  }

  async create(options: CreateTerminalOptions = {}): Promise<TerminalInfo> {
    const nodePty = await (this.#nodePty ??= loadNodePty());
    const id = randomUUID();
    const cols = clampDimension(options.cols, DEFAULT_COLS);
    const rows = clampDimension(options.rows, DEFAULT_ROWS);
    const cwd = options.cwd || process.cwd();
    const shell = options.shell || defaultShell();
    const args = options.args ?? (process.platform === "win32" ? [] : ["-l"]);
    const title = options.title || shell.split("/").pop() || "shell";

    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === null) delete env[name];
      else if (value !== undefined) env[name] = value;
    }

    const pty = nodePty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    const headless = new HeadlessTerminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);

    const session: TerminalSession = {
      info: {
        id,
        title,
        cwd,
        pid: pty.pid,
        cols,
        rows,
        exited: false,
        exitCode: null,
        createdAt: Date.now(),
        isInteractedWith: false,
      },
      pty,
      headless,
      serializer,
      listeners: new Set(),
      disposables: [],
    };

    session.disposables.push(
      pty.onData((data) => {
        headless.write(data);
        for (const listener of session.listeners) {
          listener.onData(data);
        }
      }),
      pty.onExit(({ exitCode }) => {
        session.info.exited = true;
        session.info.exitCode = exitCode;
        for (const listener of session.listeners) {
          listener.onExit?.(exitCode);
        }
      }),
    );

    this.sessions.set(id, session);
    return { ...session.info };
  }

  attach(id: string, listener: TerminalListener): TerminalAttachment | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    const snapshot: TerminalSnapshot = {
      info: { ...session.info },
      data: session.serializer.serialize(),
    };
    session.listeners.add(listener);

    return {
      snapshot,
      detach: () => {
        session.listeners.delete(listener);
      },
    };
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.info.exited || !data.length) return;
    session.pty.write(data);
    if (!session.info.isInteractedWith) {
      session.info.isInteractedWith = true;
      for (const listener of session.listeners)
        listener.onStateChange?.({ isInteractedWith: true });
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.exited) return;
    const nextCols = clampDimension(cols, session.info.cols);
    const nextRows = clampDimension(rows, session.info.rows);
    if (nextCols === session.info.cols && nextRows === session.info.rows) return;

    session.info.cols = nextCols;
    session.info.rows = nextRows;
    session.pty.resize(nextCols, nextRows);
    session.headless.resize(nextCols, nextRows);

    for (const listener of session.listeners) {
      listener.onResize?.(nextCols, nextRows);
    }
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);

    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    if (!session.info.exited) {
      try {
        session.pty.kill();
      } catch {
        // Ignore already-exited process
      }
    }
    session.headless.dispose();
    const listeners = [...session.listeners];
    session.listeners.clear();
    for (const listener of listeners) listener.onClose?.();
    return true;
  }

  dispose(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }
}
