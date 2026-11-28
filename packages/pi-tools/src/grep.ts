import { spawn } from "node:child_process";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

export const grepParameters = z.object({
  pattern: z.string().describe("Search pattern (regex or literal string)"),
  path: z.string().optional().describe("Directory or file to search (default: current directory)"),
  glob: z
    .string()
    .optional()
    .describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
  literal: z
    .boolean()
    .optional()
    .describe("Treat pattern as literal string instead of regex (default: false)"),
  context: z
    .number()
    .optional()
    .describe("Number of lines to show before and after each match (default: 0)"),
  limit: z.number().optional().describe("Maximum number of matches to return (default: 100)"),
});

export function useGrepTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepParameters,
    async execute({ pattern, path, glob, ignoreCase, literal, context, limit }, { signal }) {
      signal.throwIfAborted();
      const searchPath = cwdService.resolve(path ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      const args = ["--line-number", "--no-heading", "--color=never"];
      if (ignoreCase) args.push("--ignore-case");
      if (literal) args.push("--fixed-strings");
      if (glob) args.push("--glob", glob);
      if (context && context > 0) args.push("--context", String(Math.trunc(context)));
      args.push("--", pattern, searchPath);

      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("rg", args, {
          cwd: cwdService.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        const onAbort = () => child.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
        child.on("error", (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (code) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            reject(new Error("Operation aborted"));
            return;
          }
          if (code !== 0 && code !== 1) {
            reject(
              new Error(
                Buffer.concat(errChunks).toString("utf-8").trim() || `rg exited with code ${code}`,
              ),
            );
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      });

      const rawLines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
      if (rawLines.length === 0) {
        return "No matches found";
      }

      const limitReached = rawLines.length > effectiveLimit;
      const selected = limitReached ? rawLines.slice(0, effectiveLimit) : rawLines;
      let linesTruncated = false;
      const formatted = selected.map((line) => {
        if (line.length > GREP_MAX_LINE_LENGTH) {
          linesTruncated = true;
          return `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`;
        }
        return line;
      });

      const truncation = truncateHead(formatted.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const notices: string[] = [];
      if (limitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }
      return output;
    },
  }));
}
