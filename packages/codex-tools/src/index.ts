import {
  ApplyPatchError,
  CodexApplyPatchService,
  type VerifiedPatch,
} from "@harness/codex-apply-patch";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { JobService } from "@harness/jobs";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { ExecSessionStore } from "./exec.ts";
import {
  applyPatchParameters,
  execCommandParameters,
  writeStdinParameters,
} from "./parameters.ts";
import { useUpdatePlanTool } from "./update-plan.ts";
import { useViewImageTool } from "./view-image.ts";
import { useWebSearchTool } from "./web-search.ts";

export {
  createRequestUserInputAsyncTool,
  createRequestUserInputTool,
  shouldEnableRequestUserInput,
  type RequestUserInputOptions,
} from "./request-user-input.ts";

export {
  clampExecYieldTime,
  clampWriteStdinYieldTime,
  DEFAULT_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS,
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ExecJob,
  ExecSessionStore,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_EXEC_PROCESSES,
  MAX_MODEL_OUTPUT_BYTES,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  PROTECTED_EXEC_SESSIONS,
  type ExecCollectOptions,
  type ExecJobOptions,
  type ExecRequestContext,
  type ExecSessionStoreOptions,
} from "./exec.ts";
export {
  applyPatchParameters,
  execCommandParameters,
  updatePlanParameters,
  viewImageParameters,
  webSearchParameters,
  writeStdinParameters,
  type ApplyPatchArgs,
  type ExecCommandArgs,
  type UpdatePlanArgs,
  type ViewImageArgs,
  type WebSearchArgs,
  type WriteStdinArgs,
} from "./parameters.ts";
export { useUpdatePlanTool } from "./update-plan.ts";
export { useViewImageTool } from "./view-image.ts";
export { useWebSearchTool } from "./web-search.ts";

export interface CodexToolsOptions {
  readonly updatePlan?: boolean; // 默认 false
  readonly viewImage?: boolean; // 默认 true
  readonly webSearch?: boolean; // 默认 true
  readonly maxOutputTokens?: number; // 默认 10000
  readonly backgroundTerminalMaxTimeoutMs?: number; // 默认 300000
  readonly registerApplyPatchTool?: boolean; // 默认 false
}

const EXEC_COMMAND_DESCRIPTION =
  "Runs a command in a PTY, returning output or a session ID for ongoing interaction.";
const WRITE_STDIN_DESCRIPTION =
  "Writes characters to an existing unified exec session and returns recent output.";
const APPLY_PATCH_DESCRIPTION =
  "The `apply_patch` tool can be used to edit files. Provide the complete patch text in the `patch` parameter.";

export function useExecCommandTool(options: CodexToolsOptions = {}): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  const jobService = inject(JobService);
  const applyPatch = inject(CodexApplyPatchService);
  const store = new ExecSessionStore(jobService, cwdService, applyPatch, {
    maxOutputTokens: options.maxOutputTokens,
    backgroundTerminalMaxTimeoutMs: options.backgroundTerminalMaxTimeoutMs,
  });

  toolCall.useTool(functionTool({
    name: "exec_command",
    description: EXEC_COMMAND_DESCRIPTION,
    parameters: execCommandParameters,
<<<<<<< HEAD
    execute: (args, { signal }) => store.execCommand(args, signal),
  }));
=======
    execute: (args, { signal, reportOutput }) =>
      store.execCommand(args, { signal, reportOutput }),
  });
>>>>>>> origin/main

  toolCall.useTool(functionTool({
    name: "write_stdin",
    description: WRITE_STDIN_DESCRIPTION,
    parameters: writeStdinParameters,
<<<<<<< HEAD
    execute: (args, { signal }) => store.writeStdin(args, signal),
  }));
=======
    execute: (args, { signal, reportOutput }) =>
      store.writeStdin(args, { signal, reportOutput }),
  });
>>>>>>> origin/main
}

export function useCodexTools(options: CodexToolsOptions = {}): void {
  useExecCommandTool(options);
  useViewImageTool(options);
  if (options.webSearch !== false) useWebSearchTool();
  if (options.updatePlan === true) useUpdatePlanTool();
  if (options.registerApplyPatchTool === true) useApplyPatchTool();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useApplyPatchTool(): void {
  const toolCall = inject(ToolCallService);
  const applyPatch = inject(CodexApplyPatchService);
  toolCall.useTool({
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    parameters: applyPatchParameters,
    execute({ patch }) {
      let verified: VerifiedPatch;
      try {
        verified = applyPatch.verify(patch);
      } catch (error) {
        if (error instanceof ApplyPatchError) {
          throw new Error(`apply_patch verification failed: ${error.message}`);
        }
        throw error;
      }
      const start = performance.now();
      try {
        const summary = applyPatch.formatSummary(applyPatch.apply(verified));
        const wallTime = ((performance.now() - start) / 1000).toFixed(1);
        return `Exit code: 0\nWall time: ${wallTime} seconds\nOutput:\n${summary}`;
      } catch (error) {
        const wallTime = ((performance.now() - start) / 1000).toFixed(1);
        throw new Error(
          `Exit code: 1\nWall time: ${wallTime} seconds\nOutput:\n${formatError(error)}\n`,
        );
      }
    },
  });
}
