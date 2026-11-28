import { isAbsolute, resolve } from "node:path";
import { Diagnostic, Range, Uri } from "@harness/vscode-types";
import type { ExtHostBridge } from "./bridge.ts";
import { getTextDocuments } from "./document.ts";

type Pattern = {
  name?: string;
  regexp: string;
  file?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  location?: number;
  message?: number;
  severity?: number;
  code?: number;
  loop?: boolean;
};
type Matcher = {
  name: string;
  owner?: string;
  source?: string;
  severity?: string;
  fileLocation?: string | string[];
  applyTo?: string;
  pattern: string | Pattern | Pattern[];
  background?: {
    beginsPattern?: string | { regexp: string };
    endsPattern?: string | { regexp: string };
  };
};
type Diagnostics = {
  clear(): void;
  set(uri: Uri, values: readonly Diagnostic[]): void;
  dispose(): void;
};
export type TaskDiagnosticService = { createDiagnosticCollection(name: string): Diagnostics };

export function createTaskProblems(bridge: ExtHostBridge, languages?: TaskDiagnosticService) {
  const patterns = new Map<string, Pattern>();
  const matchers = new Map<string, Matcher>();
  const collections = new Map<string, Diagnostics>();
  bridge.commandHandlers.set("__tasks.syncProblemMatchers", (raw) => {
    const values = raw as { patterns: Pattern[]; matchers: Matcher[] };
    for (const value of values.patterns) if (value.name) patterns.set(value.name, value);
    for (const value of values.matchers) matchers.set(value.name, value);
  });
  return {
    create(names: string[], cwd: string) {
      const handlers = names.map((name) => {
        const matcher = matchers.get(name.replace(/^\$/, ""));
        if (!matcher) throw new Error(`Unknown problem matcher: ${name}`);
        if (!languages) throw new Error("Task diagnostics are not connected");
        const owner = matcher.owner ?? matcher.name;
        let collection = collections.get(owner);
        if (!collection) {
          collection = languages.createDiagnosticCollection(owner);
          collections.set(owner, collection);
        }
        collection.clear();
        const result = new Map<string, [Uri, Diagnostic[]]>();
        const rawPattern =
          typeof matcher.pattern === "string"
            ? patterns.get(matcher.pattern.replace(/^\$/, ""))
            : matcher.pattern;
        if (!rawPattern) throw new Error(`Unknown problem pattern: ${String(matcher.pattern)}`);
        const sequence = (Array.isArray(rawPattern) ? rawPattern : [rawPattern]).map((pattern) => ({
          ...pattern,
          expression: new RegExp(pattern.regexp),
        }));
        let index = 0;
        let captured: Record<string, string> = {};
        const begin = matcher.background?.beginsPattern;
        const beginExpression = begin
          ? new RegExp(typeof begin === "string" ? begin : begin.regexp)
          : undefined;
        const report = () => {
          if (!captured.file || !captured.message) return;
          const location = captured.location?.split(/[:,]/).map(Number) ?? [];
          const line = Math.max(0, Number(captured.line ?? location[0] ?? 1) - 1),
            column = Math.max(0, Number(captured.column ?? location[1] ?? 1) - 1);
          const endLine = Math.max(line, Number(captured.endLine ?? location[2] ?? line + 1) - 1);
          const endColumn =
            captured.endColumn || location[3]
              ? Math.max(column, Number(captured.endColumn ?? location[3]) - 1)
              : column + 1;
          const fileLocation = matcher.fileLocation;
          const base = Array.isArray(fileLocation)
            ? (fileLocation[1] ?? cwd)
                .replaceAll("${cwd}", cwd)
                .replaceAll("${workspaceFolder}", cwd)
            : cwd;
          const uri = Uri.file(
            isAbsolute(captured.file) ? captured.file : resolve(base, captured.file),
          );
          const opened = getTextDocuments(bridge).has(uri.toString());
          if (
            (matcher.applyTo === "closedDocuments" && opened) ||
            (matcher.applyTo === "openDocuments" && !opened)
          )
            return;
          const severity = captured.severity ?? matcher.severity ?? "error";
          const diagnostic = new Diagnostic(
            new Range(line, column, endLine, endColumn),
            captured.message,
            severity === "warning" ? 1 : severity === "info" ? 2 : 0,
          );
          diagnostic.source = matcher.source;
          diagnostic.code = captured.code;
          const entry = result.get(uri.toString()) ?? [uri, []];
          entry[1].push(diagnostic);
          result.set(uri.toString(), entry);
          collection!.set(uri, entry[1]);
        };
        return (line: string) => {
          if (beginExpression?.test(line)) {
            collection!.clear();
            result.clear();
            captured = {};
            index = 0;
            return;
          }
          let pattern = sequence[index]!;
          let match = pattern.expression.exec(line);
          if (!match && index > 0) {
            index = 0;
            captured = {};
            pattern = sequence[0]!;
            match = pattern.expression.exec(line);
          }
          if (!match) return;
          for (const key of [
            "file",
            "line",
            "column",
            "endLine",
            "endColumn",
            "location",
            "message",
            "severity",
            "code",
          ] as const)
            if (pattern[key] !== undefined) captured[key] = match[pattern[key]!] ?? "";
          if (index === sequence.length - 1) {
            report();
            if (!pattern.loop) {
              index = 0;
              captured = {};
            }
          } else index++;
        };
      });
      let pending = "";
      const line = (value: string) => {
        const text = value
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\r$/, "");
        for (const handler of handlers) handler(text);
      };
      return {
        write(data: string) {
          pending += data;
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const value of lines) line(value);
        },
        finish() {
          if (pending) line(pending);
          pending = "";
        },
      };
    },
  };
}
