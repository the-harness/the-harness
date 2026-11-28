import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inject } from "@harness/di";
import { watch, type FSWatcher } from "chokidar";
import type { ReadDirResult, ReadFileResult, WorkspaceEntry, WorkspaceWatchEvent } from "./rpc.ts";

const MAX_DIR_ENTRIES = 2000;
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 150;
const ALWAYS_IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

interface GitignoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

type GitignoreCache = Map<string, { mtimeMs: number; rules: GitignoreRule[] }>;

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

async function loadGitignoreRules(cache: GitignoreCache, root: string): Promise<GitignoreRule[]> {
  const ignorePath = path.join(root, ".gitignore");
  try {
    const stat = await fs.stat(ignorePath);
    const cached = cache.get(root);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.rules;
    }
    const raw = await fs.readFile(ignorePath, "utf-8");
    const rules: GitignoreRule[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const negated = line.startsWith("!");
      let body = negated ? line.slice(1) : line;
      const dirOnly = body.endsWith("/");
      if (dirOnly) body = body.slice(0, -1);
      body = body.replace(/^\/+/, "");
      if (!body) continue;
      rules.push({
        pattern: body,
        negated,
        dirOnly,
        regex: globToRegex(body),
      });
    }
    cache.set(root, { mtimeMs: stat.mtimeMs, rules });
    return rules;
  } catch {
    return [];
  }
}

function isIgnoredByRules(relativePath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => ALWAYS_IGNORED.has(part))) {
    return true;
  }
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

interface RootWatcherEntry {
  watcher: FSWatcher;
  listeners: Set<(event: WorkspaceWatchEvent) => void>;
}

export class WorkspaceFsService {
  readonly #gitignoreCache: GitignoreCache = new Map();
  readonly #watchers = new Map<string, RootWatcherEntry>();

  resolveSafePath(
    root: string,
    relativePath = "",
  ): {
    absRoot: string;
    target: string;
    relative: string;
  } {
    const absRoot = path.resolve(root);
    const cleanRel = relativePath.replace(/^\/+/, "");
    const target = path.resolve(absRoot, cleanRel);
    if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
      throw new Error(`Path escapes workspace root: ${relativePath}`);
    }
    const relative = path.relative(absRoot, target).split(path.sep).join("/");
    return { absRoot, target, relative };
  }

  getDefaultRoot(): string {
    const override = process.env["HARNESS_WORKSPACE_ROOT"]?.trim();
    if (override) {
      const root = path.resolve(override);
      mkdirSync(root, { recursive: true });
      return root;
    }
    const candidates = [
      path.join(homedir(), "Documents", "harness", "default-workspace"),
      path.join(homedir(), ".harness", "workspace"),
    ];
    for (const directory of candidates) {
      try {
        mkdirSync(directory, { recursive: true });
        return directory;
      } catch {
        // Try the next well-known location when this one is not writable.
      }
    }
    return process.cwd();
  }

  async readDir(root: string, relativePath = "", showIgnored = false): Promise<ReadDirResult> {
    const { absRoot, target, relative } = this.resolveSafePath(root, relativePath);
    const rules = await loadGitignoreRules(this.#gitignoreCache, absRoot);
    const dirents = await fs.readdir(target, { withFileTypes: true });

    const entries: WorkspaceEntry[] = [];
    let truncated = false;

    for (const dirent of dirents) {
      const isDir = dirent.isDirectory();
      const isFile = dirent.isFile();
      if (!isDir && !isFile) continue;

      const entryRel = relative ? `${relative}/${dirent.name}` : dirent.name;
      const ignored = isIgnoredByRules(entryRel, isDir, rules);
      if (ignored && !showIgnored) continue;

      const fullPath = path.join(target, dirent.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }

      entries.push({
        name: dirent.name,
        path: fullPath,
        relativePath: entryRel,
        type: isDir ? "directory" : "file",
        size,
        mtimeMs,
        ignored: ignored || undefined,
      });

      if (entries.length >= MAX_DIR_ENTRIES) {
        truncated = true;
        break;
      }
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { entries, truncated };
  }

  async searchFiles(
    root: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const { absRoot } = this.resolveSafePath(root);
    const rules = await loadGitignoreRules(this.#gitignoreCache, absRoot);
    const search = query.trim().toLowerCase();
    const paths: string[] = [];
    for await (const entry of fs.glob("**/*", {
      cwd: absRoot,
      withFileTypes: true,
      exclude: (entry) => {
        const relative = path.relative(absRoot, path.join(entry.parentPath, entry.name))
          .split(path.sep).join("/");
        return !!signal?.aborted || entry.isSymbolicLink() ||
          isIgnoredByRules(relative, entry.isDirectory(), rules);
      },
    })) {
      signal?.throwIfAborted();
      if (!entry.isFile()) continue;
      const relative = path.relative(absRoot, path.join(entry.parentPath, entry.name))
        .split(path.sep).join("/");
      const candidate = relative.toLowerCase();
      let cursor = 0;
      for (const ch of search) {
        const index = candidate.indexOf(ch, cursor);
        if (index < 0) {
          cursor = -1;
          break;
        }
        cursor = index + 1;
      }
      if (cursor < 0) continue;
      if (paths.length === 200) return { paths, truncated: true };
      paths.push(relative);
    }
    signal?.throwIfAborted();
    return { paths, truncated: false };
  }

  async readFile(root: string, relativePath: string): Promise<ReadFileResult> {
    const { target } = this.resolveSafePath(root, relativePath);
    const stat = await fs.stat(target);

    if (stat.size > MAX_EDITABLE_BYTES) {
      return {
        path: target,
        content: "",
        encoding: "utf-8",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        binary: false,
        tooLarge: true,
      };
    }

    const buffer = await fs.readFile(target);
    const sample = buffer.subarray(0, 8192);
    const isBinary = sample.includes(0);

    if (isBinary) {
      return {
        path: target,
        content: buffer.toString("base64"),
        encoding: "base64",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        binary: true,
        tooLarge: false,
      };
    }

    return {
      path: target,
      content: buffer.toString("utf-8"),
      encoding: "utf-8",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      binary: false,
      tooLarge: false,
    };
  }

  async writeFile(
    root: string,
    relativePath: string,
    content: string,
    expectedMtimeMs?: number,
  ): Promise<{ mtimeMs: number; size: number }> {
    const { target } = this.resolveSafePath(root, relativePath);
    if (expectedMtimeMs !== undefined) {
      const stat = await fs.stat(target).catch(() => null);
      if (stat && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
        throw new Error("File has been modified on disk");
      }
    }
    await fs.writeFile(target, content, "utf-8");
    const nextStat = await fs.stat(target);
    return { mtimeMs: nextStat.mtimeMs, size: nextStat.size };
  }

  async createFile(
    root: string,
    relativePath: string,
    content = "",
  ): Promise<{ path: string; mtimeMs: number }> {
    const { target } = this.resolveSafePath(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { encoding: "utf-8", flag: "wx" });
    const stat = await fs.stat(target);
    return { path: target, mtimeMs: stat.mtimeMs };
  }

  async createDir(root: string, relativePath: string): Promise<{ path: string }> {
    const { target } = this.resolveSafePath(root, relativePath);
    await fs.mkdir(target, { recursive: true });
    return { path: target };
  }

  async renamePath(
    root: string,
    oldRelativePath: string,
    newRelativePath: string,
  ): Promise<{ path: string }> {
    const oldResolved = this.resolveSafePath(root, oldRelativePath);
    const newResolved = this.resolveSafePath(root, newRelativePath);
    await fs.mkdir(path.dirname(newResolved.target), { recursive: true });
    await fs.rename(oldResolved.target, newResolved.target);
    return { path: newResolved.target };
  }

  async deletePath(root: string, relativePath: string): Promise<void> {
    const { absRoot, target } = this.resolveSafePath(root, relativePath);
    if (target === absRoot) {
      throw new Error("Cannot delete workspace root");
    }
    await fs.rm(target, { recursive: true, force: true });
  }

  subscribeRoots(
    roots: readonly string[],
    onEvent: (event: WorkspaceWatchEvent) => void,
  ): () => void {
    const unsubs: Array<() => void> = [];
    const pending = new Map<string, WorkspaceWatchEvent>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      for (const event of pending.values()) {
        onEvent(event);
      }
      pending.clear();
    };

    const enqueue = (event: WorkspaceWatchEvent) => {
      pending.set(`${event.type}:${event.path}`, event);
      if (!timer) {
        timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
      }
    };

    for (const rawRoot of roots) {
      const absRoot = path.resolve(rawRoot);
      if (!existsSync(absRoot)) continue;

      let entry = this.#watchers.get(absRoot);
      if (!entry) {
        const listeners = new Set<(event: WorkspaceWatchEvent) => void>();
        const realRoot = realpathSync(absRoot);
        const watcher = watch(realRoot, {
          ignoreInitial: true,
          followSymlinks: false,
          // Keep editor backup names visible to extension globs.
          atomic: false,
          ignored: (target) =>
            path
              .relative(realRoot, target)
              .split(path.sep)
              .some((part) => ALWAYS_IGNORED.has(part)),
        });
        watcher.on("error", console.error);

        const eventTypes = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;
        for (const type of eventTypes) {
          watcher.on(type, (target) => {
            const relativePath = path.relative(realRoot, target).split(path.sep).join("/");
            if (!relativePath) return;
            const event: WorkspaceWatchEvent = {
              type,
              root: absRoot,
              relativePath,
              path: path.join(absRoot, relativePath),
            };
            for (const listener of listeners) {
              listener(event);
            }
          });
        }

        entry = { watcher, listeners };
        this.#watchers.set(absRoot, entry);
      }

      entry.listeners.add(enqueue);
      const currentEntry = entry;
      unsubs.push(() => {
        if (currentEntry.listeners.delete(enqueue) && currentEntry.listeners.size === 0) {
          this.#watchers.delete(absRoot);
          void currentEntry.watcher.close().catch(console.error);
        }
      });
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const unsub of unsubs) unsub();
    };
  }
}
