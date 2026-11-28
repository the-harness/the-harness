import { z } from "zod";

const entry = z.object({
  variable: z.string(),
  folder: z.string().optional(),
  value: z.string(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  options: z.object({
    applyAtProcessCreation: z.boolean().optional(),
    applyAtShellIntegration: z.boolean().optional(),
  }),
});

const edit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), entry }),
  z.object({ op: z.literal("delete"), variable: z.string(), folder: z.string().optional() }),
  z.object({ op: z.literal("clear"), folder: z.string().optional() }),
]);

export const environmentUpdates = z.array(
  z.object({
    file: z.string(),
    legacy: z.string().optional(),
    edit,
  }),
);

export type EnvironmentEntry = z.infer<typeof entry>;
export type EnvironmentEdit = z.infer<typeof edit>;
export type EnvironmentUpdate = z.infer<typeof environmentUpdates>[number];

function environmentKey(variable: string, folder?: string): string {
  return `${variable}\0${folder ?? ""}`;
}

export function restoreEnvironment(raw: string): Map<string, EnvironmentEntry> {
  const entries = JSON.parse(raw) as EnvironmentEntry[];
  return new Map(entries.map((item) => [environmentKey(item.variable, item.folder), item]));
}

export function applyEnvironmentEdit(
  values: Map<string, EnvironmentEntry>,
  edit: EnvironmentEdit,
): void {
  switch (edit.op) {
    case "set":
      values.set(environmentKey(edit.entry.variable, edit.entry.folder), edit.entry);
      break;
    case "delete":
      values.delete(environmentKey(edit.variable, edit.folder));
      break;
    case "clear":
      if (edit.folder === undefined) {
        values.clear();
      } else {
        for (const [key, item] of values) {
          if (item.folder === edit.folder) values.delete(key);
        }
      }
      break;
  }
}
