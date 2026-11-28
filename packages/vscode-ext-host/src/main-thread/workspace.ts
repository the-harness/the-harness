import type { VscodeConfigAdapter, VscodeVscodeConfigTarget } from "../vscode-config.ts";
import type { UiWorkspaceService, WorkspaceEntry } from "@harness/ui-workspace";
import type {
  TextDocumentChangeEvent,
  VscodeWorkspaceCompatService,
} from "@harness/vscode-editor-compat";
import { FileSystemError, Position, Range, Uri } from "@harness/vscode-types";
import picomatch from "picomatch/posix";
import { findWorkspaceRoot } from "../workspace-root.ts";
import { updateConfiguration, type ConfigurationUpdateScope } from "./configuration.ts";

export function serializeDocumentChange(event: TextDocumentChangeEvent) {
  return {
    document: event.document.toJSON(),
    contentChanges: event.contentChanges,
    reason: event.reason,
  };
}

type Resource = string | { scheme: string; path?: string; authority?: string };
type WorkspaceFiles = Pick<UiWorkspaceService, "getRoot"> & {
  readonly activeRoots: { readonly value: readonly string[] };
  readonly resolveDocumentLanguage?: VscodeWorkspaceCompatService["resolveDocumentLanguage"];
  readonly renameDocument?: VscodeWorkspaceCompatService["renameDocument"];
  readonly saveFileEditor?: (uri: Uri) => Promise<Uri | undefined>;
  readonly saveAllFileEditors?: () => Promise<boolean>;
};
type GlobPattern =
  | string
  | {
      baseUri?: { scheme: string; path?: string; authority?: string };
      base?: string;
      pattern: string;
    };
type TextEdit = {
  start: { line: number; character: number };
  end: { line: number; character: number };
  newText: string;
};

function resourcePath(resource: Resource): string {
  if (typeof resource === "string") return resource;
  if (resource.scheme !== "file")
    throw new Error(`File system scheme is not supported: ${resource.scheme}`);
  return Uri.from(resource).fsPath;
}

function resolveRootAndRel(
  workspace: WorkspaceFiles,
  fullPath: string,
): { root: string; relativePath: string } {
  const matched = findWorkspaceRoot(workspace.activeRoots.value, fullPath);
  if (!matched)
    throw FileSystemError.NoPermissions(`Path is outside active workspace roots: ${fullPath}`);
  const cleanRoot = matched.replace(/\/+$/, "");
  return {
    root: matched,
    relativePath: fullPath === cleanRoot ? "" : fullPath.slice(cleanRoot.length + 1),
  };
}

function patternMatcher(
  pattern: GlobPattern,
  defaultRoot: string,
): (entry: WorkspaceEntry) => boolean {
  const base =
    typeof pattern === "string"
      ? defaultRoot
      : pattern.baseUri
        ? resourcePath(pattern.baseUri)
        : (pattern.base ?? defaultRoot);
  const prefix = base.replace(/\/+$/, "") + "/";
  const match = picomatch(typeof pattern === "string" ? pattern : pattern.pattern, { dot: true });
  return (entry) => entry.path.startsWith(prefix) && match(entry.path.slice(prefix.length));
}

export function createMainThreadWorkspace(
  workspace: WorkspaceFiles,
  config: VscodeConfigAdapter,
  compat?: VscodeWorkspaceCompatService,
  configurationSnapshot = () => config.snapshot(),
) {
  async function* files(
    include: GlobPattern,
    exclude?: GlobPattern | null,
  ): AsyncGenerator<WorkspaceEntry> {
    const configured = config.get<Record<string, boolean>>("files.exclude", {});
    const exclusions =
      exclude === undefined
        ? Object.entries(configured ?? {})
            .filter(([, enabled]) => enabled === true)
            .map(([pattern]) => pattern)
        : exclude === null
          ? []
          : [exclude];
    for (const root of workspace.activeRoots.value) {
      const included = patternMatcher(include, root);
      const excluded = exclusions.map((pattern) => patternMatcher(pattern, root));
      const directories = [""];
      const visited = new Set<string>();
      while (directories.length) {
        const directory = directories.pop()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        const result = await workspace.getRoot(root).loadDir(directory);
        for (const entry of result.entries) {
          if (excluded.some((matches) => matches(entry))) continue;
          if (entry.type === "directory") directories.push(entry.relativePath);
          else if (included(entry)) yield entry;
        }
      }
    }
  }

  return async (method: string, args: unknown[]): Promise<unknown> => {
    if (method === "workspace.getConfig") {
      const [key, defaultValue] = args as [string, unknown];
      return config.get(key, defaultValue);
    }
    if (method === "workspace.updateConfig") {
      const [key, value, target, remove, scope] = args as [
        string,
        unknown,
        VscodeConfigTarget?,
        boolean?,
        ConfigurationUpdateScope?,
      ];
      updateConfiguration(config, key, remove ? undefined : value, target ?? "workspace", scope);
      return configurationSnapshot();
    }
    if (method === "workspace.readFile" || method === "workspace.readFileBytes") {
      const fullPath = resourcePath(args[0] as Resource);
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      const file = await workspace.getRoot(root).readFile(relativePath);
      if (file.tooLarge) throw new Error(`File is too large: ${fullPath}`);
      if (method === "workspace.readFile") return file.content;
      return file.encoding === "base64"
        ? Array.from(atob(file.content), (character) => character.charCodeAt(0))
        : [...new TextEncoder().encode(file.content)];
    }
    if (method === "workspace.writeFile") {
      const [resource, content] = args as [Resource, string];
      const fullPath = resourcePath(resource);
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      await workspace.getRoot(root).writeFile(relativePath, content);
      return undefined;
    }
    if (method === "workspace.readDirectory") {
      const fullPath = resourcePath(args[0] as Resource);
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      const result = await workspace.getRoot(root).loadDir(relativePath);
      return result.entries.map((entry) => [entry.name, entry.type === "directory" ? 2 : 1]);
    }
    if (method === "workspace.createDirectory") {
      const fullPath = resourcePath(args[0] as Resource);
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      await workspace.getRoot(root).createDir(relativePath);
      return undefined;
    }
    if (method === "workspace.delete") {
      const [resource, options] = args as [Resource, { recursive?: boolean; useTrash?: boolean }?];
      const fullPath = resourcePath(resource);
      if (options?.useTrash) throw new Error("Moving files to trash is not supported");
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      const service = workspace.getRoot(root);
      const parent = relativePath.slice(0, relativePath.lastIndexOf("/"));
      const listing = await service.loadDir(relativePath.includes("/") ? parent : "", true);
      const entry = listing.entries.find((entry) => entry.path === fullPath);
      if (entry?.type === "directory" && !options?.recursive) {
        if ((await service.loadDir(relativePath, true)).entries.length)
          throw new Error("Directory is not empty");
      }
      await service.deletePath(relativePath);
      return undefined;
    }
    if (method === "workspace.rename") {
      const [source, target, options] = args as [Resource, Resource, { overwrite?: boolean }?];
      const oldPath = resourcePath(source);
      const newPath = resourcePath(target);
      const from = resolveRootAndRel(workspace, oldPath);
      const to = resolveRootAndRel(workspace, newPath);
      if (from.root !== to.root)
        throw new Error("Renaming across workspace roots is not supported");
      if (!options?.overwrite) {
        const parent = to.relativePath.includes("/")
          ? to.relativePath.slice(0, to.relativePath.lastIndexOf("/"))
          : "";
        const listing = await workspace.getRoot(to.root).loadDir(parent, true);
        if (listing.entries.some((entry) => entry.path === newPath))
          throw new Error(`File already exists: ${newPath}`);
      }
      if (workspace.renameDocument)
        await workspace.renameDocument(from.root, from.relativePath, to.relativePath);
      else if (compat) await compat.renameDocument(from.root, from.relativePath, to.relativePath);
      else await workspace.getRoot(from.root).renamePath(from.relativePath, to.relativePath);
      return undefined;
    }
    if (method === "workspace.resolveDocumentLanguage") {
      const [path, firstLine] = args as [string, string];
      return workspace.resolveDocumentLanguage?.(path, firstLine) ?? "plaintext";
    }
    if (method === "workspace.openTextDocument") {
      const fullPath = resourcePath(args[0] as Resource);
      if (compat) return (await compat.openTextDocument(fullPath)).toJSON();
      const { root, relativePath } = resolveRootAndRel(workspace, fullPath);
      const file = await workspace.getRoot(root).readFile(relativePath);
      if (file.binary || file.tooLarge) throw new Error(`Cannot open text document: ${fullPath}`);
      return {
        uri: Uri.file(fullPath).toJSON(),
        text: file.content,
        languageId: "plaintext",
        version: 1,
        eol: file.content.includes("\r\n") ? 2 : 1,
        isDirty: false,
      };
    }
    if (method === "workspace.saveTextDocument") {
      if (!compat) return false;
      return await (await compat.openTextDocument(resourcePath(args[0] as Resource))).save();
    }
    if (method === "workspace.save") {
      const uri = Uri.from(args[0] as Parameters<typeof Uri.from>[0]);
      return (await workspace.saveFileEditor?.(uri))?.toJSON();
    }
    if (method === "workspace.saveAll") {
      return (await workspace.saveAllFileEditors?.()) ?? false;
    }
    if (method === "workspace.findTextInFiles") {
      const [query, options = {}] = args as [
        { pattern: string; isRegExp?: boolean; isCaseSensitive?: boolean; isWordMatch?: boolean },
        { include?: GlobPattern; exclude?: GlobPattern | null; maxResults?: number }?,
      ];
      let pattern = query.isRegExp
        ? query.pattern
        : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (query.isWordMatch) pattern = `\\b(?:${pattern})\\b`;
      const regex = new RegExp(pattern, query.isCaseSensitive ? "g" : "gi");
      const hits: { path: string; line: number; text: string; start: number; end: number }[] = [];
      const maximum = options.maxResults ?? Infinity;
      for await (const entry of files(options.include ?? "**/*", options.exclude)) {
        const { root, relativePath } = resolveRootAndRel(workspace, entry.path);
        const file = await workspace.getRoot(root).readFile(relativePath);
        if (file.binary || file.tooLarge) continue;
        const lines = file.content.split(/\r\n|\r|\n/);
        for (let line = 0; line < lines.length; line++) {
          for (const match of lines[line]!.matchAll(regex)) {
            if (hits.length >= maximum) return { hits, limitHit: true };
            hits.push({
              path: entry.path,
              line,
              text: lines[line]!,
              start: match.index,
              end: match.index + match[0].length,
            });
          }
        }
      }
      return { hits, limitHit: false };
    }
    if (method === "workspace.applyEdit") {
      if (!compat) return false;
      const [entries] = args as [[Resource, TextEdit[]][]];
      return await compat.applyEdit(
        entries.map(([resource, edits]) => [
          Uri.file(resourcePath(resource)),
          edits.map((edit) => ({
            range: new Range(
              new Position(edit.start.line, edit.start.character),
              new Position(edit.end.line, edit.end.character),
            ),
            newText: edit.newText,
          })),
        ]),
      );
    }
    return undefined;
  };
}
