import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  ApplyPatchError,
  type CodexApplyPatchService,
  type VerifiedPatch,
} from "@harness/codex-apply-patch";
import type { CwdService } from "@harness/cwd";
import { Job, type JobContext, type JobService } from "@harness/jobs";
import { getCurrentScope, onScopeDispose } from "reactivity";
import type { ExecCommandArgs, WriteStdinArgs } from "./parameters.ts";

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const MIN_YIELD_TIME_MS = 250;
export const MAX_YIELD_TIME_MS = 30_000;
export const MIN_EMPTY_YIELD_TIME_MS = 5_000;
export const DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
// Codex's fallback model declares `truncation_policy: bytes(10_000)`.
export const MAX_MODEL_OUTPUT_BYTES = 10_000;
export const MAX_EXEC_PROCESSES = 64;
export const PROTECTED_EXEC_SESSIONS = 8;
export const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;

const BYTES_PER_TOKEN = 4;
const SERIALIZATION_ALLOWANCE = 1.2;
const HEAD_BUDGET = MAX_CAPTURED_OUTPUT_BYTES / 2;
const TAIL_BUDGET = MAX_CAPTURED_OUTPUT_BYTES - HEAD_BUDGET;
const INTERRUPT = "\u0003";
const EMPTY = Buffer.alloc(0);

const EXEC_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  CODEX_CI: "1",
};

export interface ExecJobOptions {
  readonly shell?: string;
  readonly login?: boolean;
  readonly tty?: boolean;
}

export interface ExecCollectOptions {
  readonly signal?: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
  readonly maxOutputTokens?: number;
}

export interface ExecRequestContext {
  readonly signal?: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
}

export interface ExecSessionStoreOptions {
  readonly maxOutputTokens?: number;
  readonly backgroundTerminalMaxTimeoutMs?: number;
}

interface CapturedOutput {
  readonly text: string;
  readonly omittedBytes: number;
  readonly totalBytes: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampExecYieldTime(yieldTimeMs = DEFAULT_EXEC_YIELD_TIME_MS): number {
  return clamp(yieldTimeMs, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

export function clampWriteStdinYieldTime(
  chars: string,
  yieldTimeMs?: number,
  backgroundTerminalMaxTimeoutMs = DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS,
): number {
  const requested = Math.max(yieldTimeMs ?? MIN_YIELD_TIME_MS, MIN_YIELD_TIME_MS);
  if (chars.length === 0) {
    const maxEmptyYieldTime = Math.max(
      backgroundTerminalMaxTimeoutMs,
      MIN_EMPTY_YIELD_TIME_MS,
    );
    return clamp(requested, MIN_EMPTY_YIELD_TIME_MS, maxEmptyYieldTime);
  }
  return Math.min(requested, MAX_YIELD_TIME_MS);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function approxTokenCount(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return text.endsWith("\n") ? count : count + 1;
}

function utf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

function utf8Suffix(buffer: Buffer, maxBytes: number): Buffer {
  let start = Math.max(buffer.length - maxBytes, 0);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

interface TruncationPolicy {
  readonly kind: "tokens" | "bytes";
  readonly byteBudget: number;
}

function truncateMiddle(text: string, policy: TruncationPolicy): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= policy.byteBudget) return text;
  const leftBudget = Math.floor(policy.byteBudget / 2);
  const rightBudget = policy.byteBudget - leftBudget;
  const prefix = utf8Prefix(buffer, leftBudget).toString("utf-8");
  const suffix = utf8Suffix(buffer, rightBudget).toString("utf-8");
  if (policy.kind === "bytes") {
    const removedChars = text.length - prefix.length - suffix.length;
    return `${prefix}…${removedChars} chars truncated…${suffix}`;
  }
  const removedTokens = approxTokenCount(buffer.length - policy.byteBudget);
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function formatTruncatedOutput(text: string, policy: TruncationPolicy): string {
  if (byteLength(text) <= policy.byteBudget) return text;
  const originalTokenCount = approxTokenCount(byteLength(text));
  const totalLines = countLines(text);
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${truncateMiddle(text, policy)}`;
}

function formatOmissionMarker(omittedBytes: number): string {
  return `... ${omittedBytes} bytes omitted ...`;
}

function renderCapturedOutput(
  captured: CapturedOutput,
  policy: TruncationPolicy,
  originalTokenCount: number,
): string {
  if (captured.omittedBytes === 0) {
    return formatTruncatedOutput(captured.text, policy);
  }
  const truncated = truncateMiddle(captured.text, policy);
  const marker = formatOmissionMarker(captured.omittedBytes);
  const notice = truncated.includes(marker) ? "" : `${marker}\n`;
  if (byteLength(captured.text) <= policy.byteBudget) {
    return notice === "" ? truncated : `${notice}${truncated}`;
  }
  return `Warning: truncated output (original token count: ${originalTokenCount})\n${notice}\n${truncated}`;
}

function resolveModelOutputPolicy(maxOutputTokens: number): TruncationPolicy {
  const requested = Math.max(0, Math.trunc(maxOutputTokens)) * BYTES_PER_TOKEN;
  return requested < MAX_MODEL_OUTPUT_BYTES
    ? { kind: "tokens", byteBudget: requested }
    : { kind: "bytes", byteBudget: MAX_MODEL_OUTPUT_BYTES };
}

interface ExecResponseState {
  readonly chunkId: string;
  readonly wallTimeSeconds: number;
  readonly exitCode?: number;
  readonly sessionId?: number;
  readonly originalTokenCount: number;
  readonly captured: CapturedOutput;
  readonly maxOutputTokens: number;
}

function resolveMaxOutputTokens(requested: number | undefined, fallback: number): number {
  const tokens = requested === undefined ? fallback : requested;
  return Math.max(0, Math.trunc(tokens));
}

function renderExecResponse(state: ExecResponseState): string {
  const lines = [
    `Chunk ID: ${state.chunkId}`,
    `Wall time: ${state.wallTimeSeconds.toFixed(4)} seconds`,
  ];
  if (state.exitCode !== undefined) {
    lines.push(`Process exited with code ${state.exitCode}`);
  }
  if (state.sessionId !== undefined) {
    lines.push(`Process running with session ID ${state.sessionId}`);
  }
  lines.push(`Original token count: ${state.originalTokenCount}`);
  lines.push("Output:");
  const header = lines.join("\n");
  const policy = resolveModelOutputPolicy(
    Math.min(state.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
  );
  const responseBudget = Math.max(
    0,
    Math.ceil(policy.byteBudget * SERIALIZATION_ALLOWANCE) - byteLength(header) - 1,
  );
  let budget = policy.byteBudget;
  let output = renderCapturedOutput(
    state.captured,
    { kind: policy.kind, byteBudget: budget },
    state.originalTokenCount,
  );
  while (byteLength(output) > responseBudget && budget > 0) {
    const excess = byteLength(output) - responseBudget;
    budget =
      policy.kind === "bytes"
        ? Math.max(0, budget - excess)
        : Math.max(0, budget - approxTokenCount(excess) * BYTES_PER_TOKEN);
    output = renderCapturedOutput(
      state.captured,
      { kind: policy.kind, byteBudget: budget },
      state.originalTokenCount,
    );
  }
  return `${header}\n${output}`;
}

function generateChunkId(): string {
  return randomBytes(3).toString("hex");
}

function deriveShellCommand(
  cmd: string,
  shell: string | undefined,
  login: boolean,
): { readonly shell: string; readonly args: string[] } {
  if (shell !== undefined) {
    return { shell, args: [login ? "-lc" : "-c", cmd] };
  }
  if (process.platform === "win32") {
    return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", cmd] };
  }
  return { shell: process.env.SHELL || "bash", args: [login ? "-lc" : "-c", cmd] };
}

function parseLegacyApplyPatchCommand(
  cmd: string,
  cwd: string,
): { readonly patch: string; readonly cwd: string } | undefined {
  const trimmed = cmd.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const command = (parsed as { readonly command?: unknown }).command;
  if (Array.isArray(command)) {
    if (command.length !== 2) return undefined;
    const [name, body] = command;
    if (name !== "apply_patch" && name !== "applypatch") return undefined;
    if (typeof body === "string") return { patch: body, cwd };
    if (Array.isArray(body) && body.every((line) => typeof line === "string")) {
      return { patch: body.join("\n"), cwd };
    }
    return undefined;
  }
  if (typeof command !== "string") return undefined;
  const match = /^(apply_patch|applypatch)(?:\s+|$)([\s\S]*)$/u.exec(command);
  return match ? { patch: match[2]!, cwd } : undefined;
}

function verificationError(error: unknown): Error {
  if (error instanceof ApplyPatchError) {
    return new Error(`apply_patch verification failed: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

class CapturedOutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omittedBytes = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const headRemaining = HEAD_BUDGET - this.headBytes;
    let rest = chunk;
    if (headRemaining > 0) {
      const part = chunk.length <= headRemaining ? chunk : chunk.subarray(0, headRemaining);
      this.head.push(part);
      this.headBytes += part.length;
      rest = chunk.length <= headRemaining ? EMPTY : chunk.subarray(headRemaining);
    }
    if (rest.length === 0) return;

    const tailRemaining = TAIL_BUDGET - this.tailBytes;
    const excess = Math.max(0, rest.length - tailRemaining);
    this.omittedBytes += excess;
    let append = rest;
    if (excess > 0) {
      if (excess <= this.tailBytes) {
        this.dropTail(excess);
      } else {
        append = rest.subarray(excess - this.tailBytes);
        this.tail = [];
        this.tailBytes = 0;
      }
    }
    this.tail.push(append);
    this.tailBytes += append.length;
  }

  take(): CapturedOutput {
    const omittedBytes = this.omittedBytes;
    const head = Buffer.concat(this.head, this.headBytes);
    const tail = Buffer.concat(this.tail, this.tailBytes);
    const totalBytes = this.headBytes + this.tailBytes + omittedBytes;
    const text =
      omittedBytes === 0
        ? Buffer.concat([head, tail], totalBytes).toString("utf-8")
        : `${head.toString("utf-8")}\n${formatOmissionMarker(omittedBytes)}\n${tail.toString("utf-8")}`;
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.omittedBytes = 0;
    return { text, omittedBytes, totalBytes };
  }

  private dropTail(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0 && this.tail.length > 0) {
      const first = this.tail[0]!;
      if (first.length <= remaining) {
        remaining -= first.length;
        this.tailBytes -= first.length;
        this.tail.shift();
      } else {
        this.tail[0] = first.subarray(remaining);
        this.tailBytes -= remaining;
        remaining = 0;
      }
    }
  }
}

export class ExecJob extends Job<number, void> {
  readonly id: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly shell: string | undefined;
  readonly login: boolean;
  readonly tty: boolean;
  lastUsedAt = Date.now();

  private child: ChildProcess | undefined;
  private buffer = new CapturedOutputBuffer();
  private readonly decoder = new StringDecoder("utf-8");
  private deltaSink: ((delta: string) => void) | undefined;
  private exitCodeValue: number | null = null;
  private spawnError: Error | undefined;
  private ctx: JobContext<void> | undefined;

  constructor(id: number, cmd: string, cwd: string, options: ExecJobOptions = {}) {
    super();
    this.id = id;
    this.cmd = cmd;
    this.cwd = cwd;
    this.shell = options.shell;
    this.login = options.login ?? true;
    this.tty = options.tty ?? false;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  write(chars: string): boolean {
    this.lastUsedAt = Date.now();
    if (chars.length === 0) return true;
    if (chars === INTERRUPT) {
      if (this.child === undefined) return false;
      this.child.kill("SIGINT");
      return true;
    }
    const stdin = this.child?.stdin;
    if (
      this.exitCodeValue !== null ||
      stdin === undefined ||
      stdin === null ||
      stdin.destroyed ||
      !stdin.writable
    ) {
      return false;
    }
    stdin.write(chars);
    return true;
  }

  async collect(yieldTimeMs: number, options: ExecCollectOptions = {}): Promise<string> {
    const { signal, reportOutput } = options;
    const maxOutputTokens = resolveMaxOutputTokens(
      options.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
    signal?.throwIfAborted();
    this.lastUsedAt = Date.now();
    const start = performance.now();
    this.deltaSink = reportOutput;

    try {
      if (this.exitCodeValue === null && this.spawnError === undefined && yieldTimeMs > 0) {
        await this.waitForExit(yieldTimeMs, signal);
      }
      if (this.spawnError !== undefined) throw this.spawnError;
    } finally {
      this.deltaSink = undefined;
    }
    signal?.throwIfAborted();

    const wallTimeSeconds = (performance.now() - start) / 1000;
    const captured = this.buffer.take();
    const originalTokenCount = approxTokenCount(captured.totalBytes);
    const chunkId = generateChunkId();
    if (this.exitCodeValue === null) {
      this.ctx?.yield();
      return renderExecResponse({
        chunkId,
        wallTimeSeconds,
        sessionId: this.id,
        originalTokenCount,
        captured,
        maxOutputTokens,
      });
    }
    return renderExecResponse({
      chunkId,
      wallTimeSeconds,
      exitCode: this.exitCodeValue,
      originalTokenCount,
      captured,
      maxOutputTokens,
    });
  }

  protected run(ctx: JobContext<void>): Promise<number> {
    this.ctx = ctx;
    const command = deriveShellCommand(this.cmd, this.shell, this.login);

    return new Promise<number>((resolve, reject) => {
      const child = spawn(command.shell, command.args, {
        cwd: this.cwd,
        env: { ...process.env, ...EXEC_ENV, CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;

      const onData = (data: Buffer) => {
        this.buffer.push(data);
        const delta = this.decoder.write(data);
        if (delta !== "" && this.deltaSink !== undefined) this.deltaSink(delta);
      };

      const onKill = () => {
        child.kill();
      };

      ctx.abortSignal.addEventListener("abort", onKill, { once: true });
      ctx.releaseSignal.addEventListener("abort", onKill, { once: true });

      const cleanup = () => {
        ctx.abortSignal.removeEventListener("abort", onKill);
        ctx.releaseSignal.removeEventListener("abort", onKill);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (error) => {
        cleanup();
        this.spawnError = error;
        this.child = undefined;
        reject(error);
      });
      child.on("close", (code, sig) => {
        cleanup();
        const trailing = this.decoder.end();
        if (trailing !== "" && this.deltaSink !== undefined) this.deltaSink(trailing);
        this.exitCodeValue =
          code ?? (sig === null ? -1 : 128 + (osConstants.signals[sig] ?? 0));
        resolve(this.exitCodeValue);
      });
    });
  }

  private waitForExit(yieldTimeMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, yieldTimeMs);

      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Command aborted"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      void this.done.then(
        () => {
          cleanup();
          resolve();
        },
        () => {
          cleanup();
          resolve();
        },
      );
    });
  }
}

export class ExecSessionStore {
  private readonly sessions = new Map<number, ExecJob>();
  private readonly running = new Set<ExecJob>();
  private readonly lifetime = new AbortController();
  private nextId = 1000;
  private readonly jobService: JobService;
  private readonly cwdService: CwdService;
  private readonly applyPatchService: CodexApplyPatchService;
  private readonly maxOutputTokens: number;
  private readonly backgroundTerminalMaxTimeoutMs: number;

  constructor(
    jobService: JobService,
    cwdService: CwdService,
    applyPatchService: CodexApplyPatchService,
    options: ExecSessionStoreOptions = {},
  ) {
    if (!getCurrentScope()?.active) {
      throw new Error("ExecSessionStore requires an active EffectScope");
    }
    this.jobService = jobService;
    this.cwdService = cwdService;
    this.applyPatchService = applyPatchService;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.backgroundTerminalMaxTimeoutMs =
      options.backgroundTerminalMaxTimeoutMs ?? DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS;
    onScopeDispose(() => {
      const reason = new Error("Exec session scope disposed");
      this.lifetime.abort(reason);
      for (const job of this.running) void job.abort(reason);
      for (const job of this.sessions.values()) void job.abort(reason);
      this.running.clear();
      this.sessions.clear();
    });
  }

  async execCommand(
    args: ExecCommandArgs,
    context: ExecRequestContext = {},
  ): Promise<string> {
    const requestSignal = this.requestSignal(context.signal);
    requestSignal.throwIfAborted();
    const cwd =
      args.workdir === undefined || args.workdir === ""
        ? this.cwdService.cwd
        : this.cwdService.resolve(args.workdir);
    this.assertPermissions(args);

    const intercepted = this.interceptApplyPatch(args.cmd, cwd);
    if (intercepted !== undefined) return intercepted;

    const job = this.jobService.spawn(
      new ExecJob(this.nextId++, args.cmd, cwd, {
        shell: args.shell,
        login: args.login ?? true,
        tty: args.tty ?? false,
      }),
    );
    this.running.add(job);
    const remove = () => this.running.delete(job);
    void job.done.then(remove, remove);
    try {
      const output = await job.collect(clampExecYieldTime(args.yield_time_ms), {
        signal: requestSignal,
        reportOutput: context.reportOutput,
        maxOutputTokens: resolveMaxOutputTokens(args.max_output_tokens, this.maxOutputTokens),
      });
      requestSignal.throwIfAborted();
      if (job.exitCode === null) this.store(job);
      return output;
    } catch (error) {
      if (context.signal?.aborted) await job.abort(context.signal.reason);
      throw new Error(`exec_command failed: ${formatError(error)}`);
    }
  }

  async writeStdin(args: WriteStdinArgs, context: ExecRequestContext = {}): Promise<string> {
    const requestSignal = this.requestSignal(context.signal);
    requestSignal.throwIfAborted();
    const job = this.sessions.get(args.session_id);
    if (job === undefined) {
      throw new Error(`write_stdin failed: Unknown process id ${args.session_id}`);
    }
    const chars = args.chars ?? "";
    if (chars.length > 0 && !job.write(chars)) {
      throw new Error(
        "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      );
    }
    try {
      const output = await job.collect(
        clampWriteStdinYieldTime(chars, args.yield_time_ms, this.backgroundTerminalMaxTimeoutMs),
        {
          signal: requestSignal,
          reportOutput: context.reportOutput,
          maxOutputTokens: resolveMaxOutputTokens(args.max_output_tokens, this.maxOutputTokens),
        },
      );
      requestSignal.throwIfAborted();
      if (job.exitCode !== null) this.sessions.delete(args.session_id);
      return output;
    } catch (error) {
      throw new Error(`write_stdin failed: ${formatError(error)}`);
    }
  }

  private interceptApplyPatch(cmd: string, cwd: string): string | undefined {
    let intercepted: { readonly patch: string; readonly cwd: string } | undefined;
    try {
      intercepted =
        this.applyPatchService.extractCommand(cmd, cwd) ??
        parseLegacyApplyPatchCommand(cmd, cwd);
    } catch (error) {
      throw verificationError(error);
    }
    if (intercepted === undefined) return undefined;

    let verified: VerifiedPatch;
    try {
      verified = this.applyPatchService.verify(intercepted.patch, intercepted.cwd);
    } catch (error) {
      throw verificationError(error);
    }

    const start = performance.now();
    try {
      const changes = this.applyPatchService.apply(verified);
      const wallTime = ((performance.now() - start) / 1000).toFixed(1);
      return `Wall time: 0.0000 seconds\nOutput:\nExit code: 0\nWall time: ${wallTime} seconds\nOutput:\n${this.applyPatchService.formatSummary(changes)}`;
    } catch (error) {
      const wallTime = ((performance.now() - start) / 1000).toFixed(1);
      return `Wall time: 0.0000 seconds\nOutput:\nExit code: 1\nWall time: ${wallTime} seconds\nOutput:\n${formatError(error)}\n`;
    }
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, signal]);
  }

  private assertPermissions(args: ExecCommandArgs): void {
    if (
      args.sandbox_permissions !== undefined &&
      args.sandbox_permissions !== "use_default"
    ) {
      throw new Error(
        "approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never",
      );
    }
  }

  private store(job: ExecJob): void {
    if (this.sessions.size >= MAX_EXEC_PROCESSES) this.prune();
    this.sessions.set(job.id, job);
  }

  private prune(): void {
    const jobs = [...this.sessions.values()];
    const protectedIds = new Set(
      [...jobs]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .slice(0, PROTECTED_EXEC_SESSIONS)
        .map((job) => job.id),
    );
    const candidates = jobs.filter((job) => !protectedIds.has(job.id));
    const pool = candidates.length > 0 ? candidates : jobs;
    const exited = pool.filter((job) => job.exitCode !== null);
    const victim = (exited.length > 0 ? exited : pool).reduce((left, right) =>
      left.lastUsedAt <= right.lastUsedAt ? left : right,
    );
    this.sessions.delete(victim.id);
    void victim.abort("pruned");
  }
}
