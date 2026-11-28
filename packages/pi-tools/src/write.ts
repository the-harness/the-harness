import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";

export const writeParameters = z.object({
  path: z.string().describe("Path to the file to write (relative or absolute)"),
  content: z.string().describe("Content to write to the file"),
});

export function useWriteTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeParameters,
    async execute({ path, content }, { signal }) {
      signal.throwIfAborted();
      const absolutePath = cwdService.resolve(path);
      await mkdir(dirname(absolutePath), { recursive: true });
      signal.throwIfAborted();
      await writeFile(absolutePath, content, "utf-8");
      signal.throwIfAborted();
      return `Successfully wrote to ${path}`;
    },
  }));
}
