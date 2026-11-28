import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { getCurrentScope, onScopeDispose } from "reactivity";

export interface AgentsMdFile {
  readonly path: string;
  readonly content: string;
}

const CONTEXT_FILE_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

function readContextFileInDir(dir: string): AgentsMdFile | undefined {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return { path: filePath, content: readFileSync(filePath, "utf-8") };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export class AgentsMdService {
  readonly #cwdService = inject(CwdService);
  readonly #extraDirs = new Set<{ readonly directory: string }>();

  useSearchDir(dir: string): void {
    if (getCurrentScope() === undefined) {
      throw new Error("useSearchDir() requires an active EffectScope");
    }
    const registration = { directory: resolve(dir) };
    onScopeDispose(() => {
      this.#extraDirs.delete(registration);
    });
    this.#extraDirs.add(registration);
  }

  discover(cwd: string = this.#cwdService.cwd): AgentsMdFile[] {
    const result: AgentsMdFile[] = [];
    const seen = new Set<string>();

    const addIfPresent = (dir: string) => {
      const resolvedDir = resolve(dir);
      if (seen.has(resolvedDir)) return;
      seen.add(resolvedDir);
      const file = readContextFileInDir(resolvedDir);
      if (file) result.push(file);
    };

    for (const { directory } of this.#extraDirs) {
      addIfPresent(directory);
    }

    const ancestors: string[] = [];
    let current = resolve(cwd);
    while (true) {
      ancestors.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    ancestors.reverse();
    for (const dir of ancestors) {
      addIfPresent(dir);
    }

    return result;
  }
}
