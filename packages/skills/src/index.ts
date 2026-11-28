import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CwdService } from "@harness/cwd";
import { inject } from "@harness/di";
import { getCurrentScope, onScopeDispose } from "reactivity";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && value) fields[key] = value;
  }
  return fields;
}

function loadSkillFile(filePath: string, fallbackName: string): Skill | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    const description = fm.description;
    if (!description) return undefined;
    return {
      name: fm.name || fallbackName,
      description,
      location: filePath,
    };
  } catch {
    return undefined;
  }
}

function scanSkillsDir(dir: string, out: Map<string, Skill>): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const skillFile = join(fullPath, "SKILL.md");
      if (existsSync(skillFile)) {
        const skill = loadSkillFile(skillFile, entry);
        if (skill) out.set(skill.name, skill);
      }
    } else if (stat.isFile() && entry.endsWith(".md")) {
      const skill = loadSkillFile(fullPath, basename(entry, ".md"));
      if (skill) out.set(skill.name, skill);
    }
  }
}

export class SkillsService {
  readonly #cwdService = inject(CwdService);
  readonly #roots = new Set<{ readonly directory: string }>();

  useRoot(dir: string): void {
    if (getCurrentScope() === undefined) {
      throw new Error("useRoot() requires an active EffectScope");
    }
    const registration = { directory: resolve(dir) };
    onScopeDispose(() => {
      this.#roots.delete(registration);
    });
    this.#roots.add(registration);
  }

  discover(): Skill[] {
    const skills = new Map<string, Skill>();
    scanSkillsDir(join(homedir(), ".agents", "skills"), skills);
    scanSkillsDir(join(resolve(this.#cwdService.cwd), ".agents", "skills"), skills);
    for (const { directory } of this.#roots) {
      scanSkillsDir(directory, skills);
    }
    return [...skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.discover().find((skill) => skill.name === name);
  }
}
