import { z } from "zod";

export const execCommandParameters = z.strictObject({
  cmd: z.string().describe("Shell command to execute."),
  justification: z
    .string()
    .optional()
    .describe("User-facing approval question for `require_escalated`; omit otherwise."),
  login: z.boolean().optional().describe("Request login-shell startup. Omit to inherit."),
  max_output_tokens: z
    .number()
    .optional()
    .describe(
      "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
    ),
  prefix_rule: z
    .array(z.string())
    .optional()
    .describe(
      'Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
    ),
  sandbox_permissions: z
    .enum(["use_default", "require_escalated"])
    .optional()
    .describe(
      "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
    ),
  shell: z
    .string()
    .optional()
    .describe("Shell binary to launch. Defaults to the user's default shell."),
  tty: z
    .boolean()
    .optional()
    .describe("True allocates a PTY for the command; false or omitted uses plain pipes."),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for the command. Defaults to the turn cwd."),
  yield_time_ms: z
    .number()
    .optional()
    .describe("Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."),
});

export const writeStdinParameters = z.strictObject({
  chars: z
    .string()
    .optional()
    .describe("Bytes to write to stdin. Defaults to empty, which polls without writing."),
  max_output_tokens: z
    .number()
    .optional()
    .describe(
      "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
    ),
  session_id: z.number().describe("Identifier of the running unified exec session."),
  yield_time_ms: z
    .number()
    .optional()
    .describe(
      "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
    ),
});

export const viewImageParameters = z.strictObject({
  path: z.string().describe("Local filesystem path to an image file."),
});

export const webSearchParameters = z.strictObject({
  query: z.string().describe("Search query."),
});

export const updatePlanParameters = z.strictObject({
  explanation: z.string().optional().describe("Optional explanation for this plan update."),
  plan: z
    .array(
      z.strictObject({
        step: z.string().describe("Task step text."),
        status: z.enum(["pending", "in_progress", "completed"]).describe("Step status."),
      }),
    )
    .describe("The list of steps"),
});

export const applyPatchParameters = z.strictObject({
  patch: z
    .string()
    .describe("Complete patch text in the apply_patch format; do not wrap it in JSON."),
});

export type ExecCommandArgs = z.infer<typeof execCommandParameters>;
export type WriteStdinArgs = z.infer<typeof writeStdinParameters>;
export type ViewImageArgs = z.infer<typeof viewImageParameters>;
export type WebSearchArgs = z.infer<typeof webSearchParameters>;
export type UpdatePlanArgs = z.infer<typeof updatePlanParameters>;
export type ApplyPatchArgs = z.infer<typeof applyPatchParameters>;
