import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Context } from "@harness/context";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ModelSelectionService } from "@harness/model-selection";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

export const bashParameters = z.object({
  command: z.string().describe("Bash command to execute"),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe("Timeout in seconds (optional, no default timeout)"),
});

export interface BashExecutionOptions {
  readonly signal: AbortSignal;
  readonly reportOutput?: (delta: string) => void;
  readonly timeout?: number;
  readonly shellPath?: string;
  readonly operations?: BashOperations;
}

// Extensible through an alternate Bash execution backend.
export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      readonly onData: (data: Buffer) => void;
      readonly signal: AbortSignal;
      readonly timeout?: number;
    },
  ): Promise<{ exitCode: number | null }>;
}

export interface BashExecutionResult {
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
  readonly truncationNotice?: string;
}

async function formatBashOutput(rawOutput: string) {
  const truncation = truncateTail(rawOutput);
  const output = truncation.content;
  if (!truncation.truncated) return { output, truncated: false };

  const fullOutputPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
  await writeFile(fullOutputPath, rawOutput, "utf-8");
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  let truncationNotice: string;
  if (truncation.lastLinePartial) {
    const lastLineSize = formatSize(Buffer.byteLength(rawOutput.split("\n").pop() ?? "", "utf-8"));
    truncationNotice = `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    truncationNotice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    truncationNotice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }
  return { output, truncated: true, fullOutputPath, truncationNotice };
}

function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

// accessSync instead of existsSync: the latter rejects runnable Store aliases on Windows.
function shellPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Unix uses the absolute /bin/bash when present so that shell error prefixes and $0
// match the official tool instead of depending on how "bash" resolves from PATH.
function resolveShell(command: string, customShellPath?: string): { shell: string; args: string[] } {
  if (customShellPath) {
    if (!shellPathExists(customShellPath)) throw new Error(`Custom shell path not found: ${customShellPath}`);
    return { shell: customShellPath, args: ["-c", command] };
  }
  if (process.platform === "win32") {
    return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { shell: shellPathExists("/bin/bash") ? "/bin/bash" : "bash", args: ["-c", command] };
}

function terminateShell(child: ChildProcess): void {
  if (process.platform === "win32") {
    child.kill();
    return;
  }
  const { pid } = child;
  if (pid === undefined) return;
  if (process.platform === "darwin") {
    // Stop the shell before a killed child can wake it and let it start the next command.
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {}
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createBashExecutor(
  sessionId = inject(Context).id,
): (command: string, options: BashExecutionOptions) => Promise<BashExecutionResult> {
  const cwdService = inject(CwdService);
  const modelSelection = inject(ModelSelectionService);
  return async (command, { signal, reportOutput, timeout, shellPath, operations }) => {
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    const decoder = reportOutput ? new StringDecoder("utf-8") : undefined;
    let acceptingOutput = true;
    const onData = (data: Buffer) => {
      if (!acceptingOutput) return;
      chunks.push(data);
      const delta = decoder?.write(data);
      if (delta && !signal.aborted) reportOutput?.(delta);
    };

    const { provider, model, reasoning } = modelSelection.current;
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SESSION_ID: sessionId };
    if (provider) env.PI_PROVIDER = provider;
    if (model) env.PI_MODEL = model;
    if (reasoning !== undefined && reasoning !== false) {
      env.PI_REASONING_LEVEL = reasoning === true ? "medium" : reasoning;
    }

    let timedOut = false;
    const local = ({ shell, args }: { shell: string; args: string[] }) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(shell, args, {
          cwd: cwdService.cwd,
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const timer =
          timeout !== undefined
            ? setTimeout(() => {
                timedOut = true;
                terminateShell(child);
              }, timeout * 1000)
            : undefined;

        const onAbort = () => terminateShell(child);
        signal.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          cleanup();
          reject(error);
        });
        child.on("close", (code, sig) => {
          cleanup();
          resolve(code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1));
        });
      });
    let code: number | null = null;
    try {
      code = operations
        ? (await operations.exec(command, cwdService.cwd, { onData, signal, timeout })).exitCode
        : await local(resolveShell(command, shellPath));
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      acceptingOutput = false;
    }

    const cancelled = signal.aborted;
    const finalDelta = decoder?.end();
    if (finalDelta && !cancelled && !timedOut) reportOutput?.(finalDelta);
    const result = await formatBashOutput(Buffer.concat(chunks).toString("utf-8"));
    return {
      ...result,
      exitCode: cancelled || timedOut ? undefined : (code ?? undefined),
      cancelled,
      timedOut,
    };
  };
}

export function useBashTool(sessionId?: string): void {
  const toolCall = inject(ToolCallService);
  const execute = createBashExecutor(sessionId);
  toolCall.useTool(functionTool({
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashParameters,
    async execute({ command, timeout }, { signal, reportOutput }) {
      const result = await execute(command, { signal, reportOutput, timeout });
      let outputText = result.output || (result.cancelled || result.timedOut ? "" : "(no output)");
      if (result.truncationNotice) outputText = appendStatus(outputText, result.truncationNotice);
      if (result.cancelled) throw new Error(appendStatus(outputText, "Command aborted"));
      if (result.timedOut) {
        throw new Error(appendStatus(outputText, `Command timed out after ${timeout} seconds`));
      }
      if (result.exitCode !== 0) {
        throw new Error(appendStatus(outputText, `Command exited with code ${result.exitCode}`));
      }
      return outputText;
    },
  }));
}
