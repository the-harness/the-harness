import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { ToolCallService, functionTool } from "@harness/tool-call";
import { z } from "zod";

function prepareEditArguments(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const input = { ...(args as Record<string, unknown>) };
  if (typeof input.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(input.edits);
      if (Array.isArray(parsed)) {
        input.edits = parsed;
      }
    } catch {
      // let zod validation report the error
    }
  }
  if (
    input.edits === undefined &&
    typeof input.oldText === "string" &&
    typeof input.newText === "string"
  ) {
    input.edits = [{ oldText: input.oldText, newText: input.newText }];
    delete input.oldText;
    delete input.newText;
  }
  return input;
}

export const editParameters = z.preprocess(
  prepareEditArguments,
  z.object({
    path: z.string().describe("Path to the file to edit (relative or absolute)"),
    edits: z
      .array(
        z.object({
          oldText: z
            .string()
            .min(1)
            .describe(
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            ),
          newText: z.string().describe("Replacement text for this targeted edit."),
        }),
      )
      .min(1)
      .describe(
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
      ),
  }),
);

function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function applyEdits(
  normalizedContent: string,
  edits: z.infer<typeof editParameters>["edits"],
  path: string,
): string {
  const matched = edits.map((edit, editIndex) => {
    const oldText = normalizeToLF(edit.oldText);
    const newText = normalizeToLF(edit.newText);
    const matchIndex = normalizedContent.indexOf(oldText);
    if (matchIndex === -1) {
      throw new Error(`Could not find edits[${editIndex}] in ${path}.`);
    }
    const occurrences = normalizedContent.split(oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}.`);
    }
    return { editIndex, matchIndex, matchLength: oldText.length, newText };
  });

  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const prev = matched[i - 1]!;
    const curr = matched[i]!;
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(`edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}.`);
    }
  }

  let updated = normalizedContent;
  for (let i = matched.length - 1; i >= 0; i--) {
    const item = matched[i]!;
    updated =
      updated.slice(0, item.matchIndex) +
      item.newText +
      updated.slice(item.matchIndex + item.matchLength);
  }

  if (updated === normalizedContent) {
    throw new Error(`No changes made to ${path}.`);
  }
  return updated;
}

export function useEditTool(): void {
  const toolCall = inject(ToolCallService);
  const cwdService = inject(CwdService);
  toolCall.useTool(functionTool({
    name: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editParameters,
    async execute({ path, edits }, { signal }) {
      signal.throwIfAborted();
      const absolutePath = cwdService.resolve(path);
      await access(absolutePath, constants.R_OK | constants.W_OK);
      signal.throwIfAborted();

      const raw = await readFile(absolutePath, "utf-8");
      signal.throwIfAborted();

      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const text = bom ? raw.slice(1) : raw;
      const crlf = text.includes("\r\n");
      const updated = applyEdits(normalizeToLF(text), edits, path);
      await writeFile(
        absolutePath,
        bom + (crlf ? updated.replaceAll("\n", "\r\n") : updated),
        "utf-8",
      );
      signal.throwIfAborted();

      return `Successfully replaced ${edits.length} block(s) in ${path}.`;
    },
  }));
}
