import { access } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceFiles } from "./file-search.ts";

export async function workspaceContains(
  roots: readonly string[],
  patterns: readonly string[],
  configuration: Parameters<typeof findWorkspaceFiles>[3],
  signal: AbortSignal,
): Promise<boolean> {
  const globs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?")) {
      globs.push(pattern);
      continue;
    }
    for (const root of roots) {
      if (signal.aborted) return false;
      const exists = await access(join(root, pattern)).then(
        () => true,
        () => false,
      );
      if (exists) return !signal.aborted;
    }
  }
  if (!globs.length || signal.aborted) return false;

  const matches = await findWorkspaceFiles(
    roots,
    globs,
    { maxResults: 1 },
    configuration,
    undefined,
    AbortSignal.any([signal, AbortSignal.timeout(7_000)]),
  );
  return matches.length > 0;
}
