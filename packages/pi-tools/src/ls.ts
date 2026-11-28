import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

export const lsParameters = z.object({
  path: z.string().optional().describe("Directory to list (default: current directory)"),
  limit: z.number().optional().describe("Maximum number of entries to return (default: 500)"),
});

export function useLsTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsParameters,
    async execute({ path, limit }, { signal }) {
      signal.throwIfAborted();
      const dirPath = cwdService.resolve(path ?? ".");
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      const entries = await readdir(dirPath);
      signal.throwIfAborted();
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      const results: string[] = [];
      let entryLimitReached = false;

      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        try {
          const entryStat = await stat(join(dirPath, entry));
          results.push(entryStat.isDirectory() ? `${entry}/` : entry);
        } catch {
          continue;
        }
      }

      if (results.length === 0) {
        return "(empty directory)";
      }

      const truncation = truncateHead(results.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
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
