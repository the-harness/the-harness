import { resolve } from "node:path";
import { ApplyPatchError } from "./error.ts";
import { parsePatch } from "./parse.ts";
import { trimText } from "./text.ts";

const IMPLICIT_INVOCATION =
  'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]';

const WORD_DELIMITER = /[\s;&|<>()"'`]/;

interface Word {
  readonly value: string;
  readonly end: number;
}

interface ExtractedHeredoc {
  readonly body: string;
  readonly workdir: string | undefined;
}

function skipWhitespace(script: string, cursor: number): number {
  let index = cursor;
  while (index < script.length) {
    const char = script.charAt(index);
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") break;
    index += 1;
  }
  return index;
}

function skipSpaces(script: string, cursor: number): number {
  let index = cursor;
  while (index < script.length) {
    const char = script.charAt(index);
    if (char !== " " && char !== "\t" && char !== "\r") break;
    index += 1;
  }
  return index;
}

function readWord(script: string, cursor: number): Word | undefined {
  let end = cursor;
  while (end < script.length && !WORD_DELIMITER.test(script.charAt(end))) {
    end += 1;
  }
  if (end === cursor) return undefined;
  return { value: script.slice(cursor, end), end };
}

function readArgument(script: string, cursor: number): Word | undefined {
  const quote = script.charAt(cursor);
  if (quote !== "'" && quote !== '"') return readWord(script, cursor);
  const close = script.indexOf(quote, cursor + 1);
  if (close === -1) return undefined;
  return { value: script.slice(cursor + 1, close), end: close + 1 };
}

function extractHeredoc(script: string): ExtractedHeredoc | undefined {
  let cursor = skipWhitespace(script, 0);
  let workdir: string | undefined;
  let command = readWord(script, cursor);
  if (command === undefined) return undefined;
  if (command.value === "cd") {
    const argument = readArgument(script, skipSpaces(script, command.end));
    if (argument === undefined) return undefined;
    cursor = skipSpaces(script, argument.end);
    if (!script.startsWith("&&", cursor)) return undefined;
    workdir = argument.value;
    cursor = skipWhitespace(script, cursor + 2);
    command = readWord(script, cursor);
    if (command === undefined) return undefined;
  }
  if (command.value !== "apply_patch" && command.value !== "applypatch") {
    return undefined;
  }
  cursor = skipSpaces(script, command.end);
  if (!script.startsWith("<<", cursor)) return undefined;
  const delimiter = readArgument(script, cursor + 2);
  if (delimiter === undefined) return undefined;
  cursor = skipSpaces(script, delimiter.end);
  if (script.charAt(cursor) !== "\n") return undefined;
  const bodyStart = cursor + 1;
  let lineStart = bodyStart;
  while (lineStart <= script.length) {
    const lineEnd = script.indexOf("\n", lineStart);
    const line = script.slice(lineStart, lineEnd === -1 ? script.length : lineEnd);
    if (line === delimiter.value || line === `${delimiter.value}\r`) {
      const rest = lineEnd === -1 ? "" : script.slice(lineEnd + 1);
      if (trimText(rest) !== "") return undefined;
      const body = script.slice(bodyStart, lineStart).replace(/\n+$/u, "");
      return { body, workdir };
    }
    if (lineEnd === -1) return undefined;
    lineStart = lineEnd + 1;
  }
  return undefined;
}

function isImplicitPatch(cmd: string): boolean {
  try {
    parsePatch(cmd);
    return true;
  } catch {
    return false;
  }
}

export interface ApplyPatchCommand {
  readonly patch: string;
  readonly cwd: string;
}

export function extractApplyPatchCommand(
  cmd: string,
  cwd: string,
): ApplyPatchCommand | undefined {
  if (isImplicitPatch(cmd)) throw new ApplyPatchError(IMPLICIT_INVOCATION);
  const extracted = extractHeredoc(cmd);
  if (extracted === undefined) return undefined;
  return {
    patch: extracted.body,
    cwd: extracted.workdir === undefined ? cwd : resolve(cwd, extracted.workdir),
  };
}
