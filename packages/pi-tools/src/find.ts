import { spawn } from "node:child_process";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;

export const findParameters = z.object({
  pattern: z
    .string()
    .describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"),
  path: z.string().optional().describe("Directory to search in (default: current directory)"),
  limit: z.number().optional().describe("Maximum number of results (default: 1000)"),
});

export function useFindTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findParameters,
    async execute({ pattern, path, limit }, { signal }) {
      signal.throwIfAborted();
      const searchDir = cwdService.resolve(path ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("rg", ["--files", "--glob", pattern], {
          cwd: searchDir,
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

      const allPaths = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((p) => p.replaceAll("\\", "/"));

      if (allPaths.length === 0) {
        return "No files found matching pattern";
      }

      const limitReached = allPaths.length > effectiveLimit;
      const limited = limitReached ? allPaths.slice(0, effectiveLimit) : allPaths;
      const truncation = truncateHead(limited.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const notices: string[] = [];
      if (limitReached) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }
      return output;
    },
  }));
}
