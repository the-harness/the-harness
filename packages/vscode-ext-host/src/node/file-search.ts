import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExcludeSettingOptions, Uri, type CancellationToken } from "@harness/vscode-types";
import picomatch from "picomatch";
import type { GlobPattern } from "../vscode/workspace.ts";
import { getRipgrepPath } from "./ripgrep.ts";

export type FindFiles2Options = {
  exclude?: GlobPattern[];
  useExcludeSettings?: ExcludeSettingOptions;
  maxResults?: number;
  caseInsensitive?: boolean;
  useIgnoreFiles?: { local?: boolean; parent?: boolean; global?: boolean };
  followSymlinks?: boolean;
};

type SearchConfiguration = { get<T>(key: string, fallback: T): T | undefined };

const defaultFilesExclude = {
  "**/.git": true,
  "**/.svn": true,
  "**/.hg": true,
  "**/.jj": true,
  "**/.DS_Store": true,
  "**/Thumbs.db": true,
};
const defaultSearchExclude = {
  "**/node_modules": true,
  "**/bower_components": true,
  "**/*.code-search": true,
};

function patternRoot(pattern: Exclude<GlobPattern, string>): string | undefined {
  if (!pattern.baseUri) return pattern.base;
  if (pattern.baseUri.scheme === "file") return Uri.from(pattern.baseUri).fsPath;
}

function configuredExclusions(config: SearchConfiguration, mode: ExcludeSettingOptions): string[] {
  if (mode === ExcludeSettingOptions.None) return [];
  const fileExclusions = config.get<Record<string, boolean>>("files.exclude", {});
  const searchExclusions =
    mode === ExcludeSettingOptions.SearchAndFilesExclude
      ? { ...defaultSearchExclude, ...config.get<Record<string, boolean>>("search.exclude", {}) }
      : undefined;
  return Object.entries({ ...defaultFilesExclude, ...fileExclusions, ...searchExclusions })
    .filter(([pattern, enabled]) => enabled === true && !pattern.startsWith("!"))
    .map(([pattern]) => pattern);
}

function excludesPath(base: string, file: string, matches: (path: string) => boolean): boolean {
  const path = relative(base, file);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return false;
  let candidate = path.split(sep).join("/");
  while (candidate) {
    if (matches(candidate)) return true;
    const slash = candidate.lastIndexOf("/");
    candidate = slash === -1 ? "" : candidate.slice(0, slash);
  }
  return false;
}

function searchArguments(options: FindFiles2Options, config: SearchConfiguration): string[] {
  const args = ["--files", "--null", "--hidden", "--no-require-git", "--no-config"];
  const ignore = options.useIgnoreFiles;
  const local =
    ignore?.local ??
    (ignore?.parent || ignore?.global || config.get("search.useIgnoreFiles", true));
  if (!local) {
    if (ignore?.parent || ignore?.global)
      console.error(
        "findFiles2 requires local ignore files when enabling parent or global ignore files",
      );
    args.push("--no-ignore");
  } else {
    if (!(ignore?.parent ?? config.get("search.useParentIgnoreFiles", false)))
      args.push("--no-ignore-parent");
    if (!(ignore?.global ?? config.get("search.useGlobalIgnoreFiles", false)))
      args.push("--no-ignore-global");
  }
  if (options.followSymlinks ?? config.get("search.followSymlinks", true)) args.push("--follow");
  if (options.caseInsensitive) args.push("--ignore-file-case-insensitive");
  return args;
}

async function* listFiles(
  binary: string,
  root: string,
  args: string[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const child = spawn(binary, args, { cwd: root, signal, stdio: ["ignore", "pipe", "pipe"] });
  let failure: Error | undefined;
  child.on("error", (error) => (failure = error));
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  let pending = "";
  let listedFile = false;
  try {
    for await (const chunk of child.stdout.setEncoding("utf8")) {
      const entries = (pending + chunk).split("\0");
      pending = entries.pop()!;
      for (const entry of entries) {
        listedFile = true;
        yield entry;
      }
    }
    const code = await closed;
    if (failure) throw failure;
    if (code !== 0 && code !== 1 && !listedFile)
      throw new Error(`File search in ${root} failed: ${stderr.trim() || code}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

export async function findWorkspaceFiles(
  roots: readonly string[],
  patterns: readonly GlobPattern[],
  options: FindFiles2Options,
  config: SearchConfiguration,
  token?: CancellationToken,
  requestSignal?: AbortSignal,
): Promise<Uri[]> {
  const limit = options.maxResults ?? Infinity;
  if (!roots.length || !patterns.length || limit <= 0 || token?.isCancellationRequested) return [];
  const controller = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  const subscription = token?.onCancellationRequested?.(() => controller.abort());
  try {
    if (signal.aborted || token?.isCancellationRequested) return [];
    const globOptions = {
      dot: true,
      nocase: options.caseInsensitive,
      nonegate: true,
      windows: false,
    };
    const searches = new Map<string, string[]>();
    for (const pattern of patterns) {
      const base = typeof pattern === "string" ? undefined : patternRoot(pattern);
      const patternRoots = typeof pattern === "string" ? roots : base ? [base] : [];
      for (const root of patternRoots) {
        const directory = resolve(root);
        const glob = typeof pattern === "string" ? pattern : pattern.pattern;
        const includes = searches.get(directory);
        if (includes) includes.push(glob);
        else searches.set(directory, [glob]);
      }
    }
    const mode = options.useExcludeSettings ?? ExcludeSettingOptions.SearchAndFilesExclude;
    const exclusions = [...configuredExclusions(config, mode), ...(options.exclude ?? [])];
    const args = searchArguments(options, config);
    const binary = await getRipgrepPath();
    const found = new Set<string>();
    for (const [root, includes] of searches) {
      if (signal.aborted || token?.isCancellationRequested) return [];
      const include = picomatch(includes, globOptions);
      const excludes = exclusions.flatMap((pattern) => {
        const base = typeof pattern === "string" ? root : patternRoot(pattern);
        if (!base) return [];
        const match = picomatch(
          typeof pattern === "string" ? pattern : pattern.pattern,
          globOptions,
        );
        return [(file: string) => excludesPath(base, file, match)];
      });
      for await (const filename of listFiles(binary, root, args, signal)) {
        if (signal.aborted || token?.isCancellationRequested) return [];
        if (!include(filename.split(sep).join("/"))) continue;
        const file = join(root, filename);
        if (excludes.some((exclude) => exclude(file))) continue;
        found.add(file);
        if (found.size >= limit) break;
      }
      if (found.size >= limit) break;
    }
    return signal.aborted || token?.isCancellationRequested ? [] : [...found].map(Uri.file);
  } catch (error) {
    if (signal.aborted || token?.isCancellationRequested) return [];
    throw error;
  } finally {
    subscription?.dispose();
  }
}
