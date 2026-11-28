/**
 * Port of OpenAI Codex rust-v0.147.0 apply-patch parser.rs and streaming_parser.rs.
 * Copyright 2025 OpenAI. Apache-2.0 portions and modification notice: ../LICENSE.
 */

import { invalidHunk, invalidPatch } from "./error.ts";
import { stripTrailingCr, trimEndText, trimText } from "./text.ts";
import type { ParsedHunk, ParsedPatch, UpdateFileChunk } from "./types.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

const LAST_LINE_ERROR = "The last line of the patch must be '*** End Patch'";

interface MutableChunk {
  changeContext: string | undefined;
  readonly oldLines: string[];
  readonly newLines: string[];
  readonly contextLineIndices: [number, number][];
  isEndOfFile: boolean;
}

interface MutableUpdateHunk {
  readonly kind: "update";
  readonly path: string;
  moveTo: string | undefined;
  readonly chunks: MutableChunk[];
}

type MutableHunk =
  | { readonly kind: "add"; readonly path: string; content: string }
  | { readonly kind: "delete"; readonly path: string }
  | MutableUpdateHunk;

type Mode =
  | { readonly kind: "notStarted" }
  | { readonly kind: "started" }
  | { readonly kind: "add" }
  | { readonly kind: "delete" }
  | { readonly kind: "update"; readonly hunkLineNumber: number }
  | { readonly kind: "ended" };

function createChunk(): MutableChunk {
  return {
    changeContext: undefined,
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
  };
}

function invalidHunkHeader(line: string, lineNumber: number): Error {
  return invalidHunk(
    lineNumber,
    `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function unexpectedUpdateLine(line: string, lineNumber: number): Error {
  return invalidHunk(
    lineNumber,
    `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
  );
}

function expectedContextMarker(line: string, lineNumber: number): Error {
  return invalidHunk(
    lineNumber,
    `Expected update hunk to start with a @@ context marker, got: '${line}'`,
  );
}

class StreamingParser {
  #mode: Mode = { kind: "notStarted" };
  #hunks: MutableHunk[] = [];
  #lineNumber = 0;
  #environmentId: string | undefined = undefined;

  get environmentId(): string | undefined {
    return this.#environmentId;
  }

  get hunks(): readonly MutableHunk[] {
    return this.#hunks;
  }

  push(line: string): void {
    this.#lineNumber += 1;
    this.#process(line);
  }

  finish(line: string): void {
    this.#lineNumber += 1;
    const trimmed = trimText(line);
    if (trimmed === END_PATCH_MARKER) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#mode = { kind: "ended" };
    } else {
      this.#process(line);
    }
    if (this.#mode.kind !== "ended") {
      throw invalidPatch(LAST_LINE_ERROR);
    }
  }

  #updateHunk(): MutableUpdateHunk | undefined {
    const hunk = this.#hunks.at(-1);
    return hunk !== undefined && hunk.kind === "update" ? hunk : undefined;
  }

  #ensureUpdateHunkIsNotEmpty(line: string): void {
    const hunk = this.#updateHunk();
    if (hunk === undefined) return;
    if (hunk.chunks.length === 0 && this.#mode.kind === "update") {
      throw invalidHunk(this.#mode.hunkLineNumber, `Update file hunk for path '${hunk.path}' is empty`);
    }
    const last = hunk.chunks.at(-1);
    if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
      if (line === END_PATCH_MARKER) {
        throw invalidHunk(this.#lineNumber, "Update hunk does not contain any lines");
      }
      throw unexpectedUpdateLine(line, this.#lineNumber);
    }
  }

  #handleHeaders(trimmed: string): boolean {
    if (this.#mode.kind === "started" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this.#environmentId !== undefined) {
        throw invalidPatch("apply_patch environment_id cannot be specified more than once");
      }
      const environmentId = trimText(trimmed.slice(ENVIRONMENT_ID_MARKER.length));
      if (environmentId === "") {
        throw invalidPatch("apply_patch environment_id cannot be empty");
      }
      this.#environmentId = environmentId;
      return true;
    }
    if (trimmed === END_PATCH_MARKER) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#mode = { kind: "ended" };
      return true;
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#hunks.push({
        kind: "add",
        path: trimmed.slice(ADD_FILE_MARKER.length),
        content: "",
      });
      this.#mode = { kind: "add" };
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#hunks.push({
        kind: "delete",
        path: trimmed.slice(DELETE_FILE_MARKER.length),
      });
      this.#mode = { kind: "delete" };
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#hunks.push({
        kind: "update",
        path: trimmed.slice(UPDATE_FILE_MARKER.length),
        moveTo: undefined,
        chunks: [],
      });
      this.#mode = { kind: "update", hunkLineNumber: this.#lineNumber };
      return true;
    }
    return false;
  }

  #chunk(hunk: MutableUpdateHunk): MutableChunk {
    const last = hunk.chunks.at(-1);
    if (last !== undefined) return last;
    const chunk = createChunk();
    hunk.chunks.push(chunk);
    return chunk;
  }

  #pushContextLine(hunk: MutableUpdateHunk, text: string): void {
    const chunk = this.#chunk(hunk);
    chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
    chunk.oldLines.push(text);
    chunk.newLines.push(text);
  }

  #process(line: string): void {
    const trimmed = trimText(line);
    switch (this.#mode.kind) {
      case "notStarted": {
        if (trimmed === BEGIN_PATCH_MARKER) {
          this.#mode = { kind: "started" };
          return;
        }
        throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
      }
      case "started": {
        if (this.#handleHeaders(trimmed)) return;
        throw invalidHunkHeader(trimmed, this.#lineNumber);
      }
      case "add": {
        if (this.#handleHeaders(trimmed)) return;
        if (line.startsWith("+")) {
          const hunk = this.#hunks.at(-1);
          if (hunk !== undefined && hunk.kind === "add") {
            hunk.content += `${line.slice(1)}\n`;
            return;
          }
        }
        throw invalidHunkHeader(trimmed, this.#lineNumber);
      }
      case "delete": {
        if (this.#handleHeaders(trimmed)) return;
        throw invalidHunkHeader(trimmed, this.#lineNumber);
      }
      case "update": {
        const updateLine = trimEndText(line);
        if (this.#handleHeaders(updateLine)) return;
        const hunk = this.#updateHunk();
        if (hunk === undefined) {
          throw unexpectedUpdateLine(line, this.#lineNumber);
        }
        const last = hunk.chunks.at(-1);
        if (last !== undefined && last.isEndOfFile) {
          if (updateLine === "") return;
          if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
            throw expectedContextMarker(line, this.#lineNumber);
          }
        }
        if (hunk.chunks.length === 0 && hunk.moveTo === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
          hunk.moveTo = updateLine.slice(MOVE_TO_MARKER.length);
          return;
        }
        const changeContext =
          updateLine === EMPTY_CHANGE_CONTEXT_MARKER ||
          updateLine.startsWith(CHANGE_CONTEXT_MARKER);
        if (
          changeContext &&
          last !== undefined &&
          last.oldLines.length === 0 &&
          last.newLines.length === 0
        ) {
          throw unexpectedUpdateLine(line, this.#lineNumber);
        }
        if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
          hunk.chunks.push(createChunk());
          return;
        }
        if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
          const chunk = createChunk();
          chunk.changeContext = updateLine.slice(CHANGE_CONTEXT_MARKER.length);
          hunk.chunks.push(chunk);
          return;
        }
        if (updateLine === EOF_MARKER) {
          if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
            throw invalidHunk(this.#lineNumber, "Update hunk does not contain any lines");
          }
          if (last !== undefined) last.isEndOfFile = true;
          return;
        }
        if (line === "") {
          this.#pushContextLine(hunk, "");
          return;
        }
        if (line.startsWith(" ")) {
          this.#pushContextLine(hunk, line.slice(1));
          return;
        }
        if (line.startsWith("+")) {
          this.#chunk(hunk).newLines.push(line.slice(1));
          return;
        }
        if (line.startsWith("-")) {
          this.#chunk(hunk).oldLines.push(line.slice(1));
          return;
        }
        if (last !== undefined && (last.oldLines.length > 0 || last.newLines.length > 0)) {
          throw expectedContextMarker(line, this.#lineNumber);
        }
        throw unexpectedUpdateLine(line, this.#lineNumber);
      }
      case "ended": {
        if (trimmed === "") return;
        throw invalidPatch(LAST_LINE_ERROR);
      }
    }
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const lastIndex = lines.length - 1;
  return lines.map((line, index) =>
    index === lastIndex ? line : stripTrailingCr(line),
  );
}

function checkBoundaries(lines: readonly string[]): Error | undefined {
  const firstRaw = lines.at(0);
  const lastRaw = lines.at(-1);
  const first = firstRaw === undefined ? undefined : trimText(firstRaw);
  const last = lastRaw === undefined ? undefined : trimText(lastRaw);
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return undefined;
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
    return invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  return invalidPatch(LAST_LINE_ERROR);
}

function patchLines(text: string): readonly string[] {
  const lines = splitLines(trimText(text));
  const error = checkBoundaries(lines);
  if (error === undefined) return lines;
  const first = lines.at(0);
  const last = lines.at(-1);
  const heredoc =
    first !== undefined &&
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last !== undefined &&
    last.endsWith("EOF") &&
    lines.length >= 4;
  if (!heredoc) throw error;
  const inner = lines.slice(1, -1);
  const innerError = checkBoundaries(inner);
  if (innerError !== undefined) throw innerError;
  return inner;
}

function toChunk(chunk: MutableChunk): UpdateFileChunk {
  return {
    changeContext: chunk.changeContext,
    oldLines: chunk.oldLines,
    newLines: chunk.newLines,
    contextLineIndices: chunk.contextLineIndices,
    isEndOfFile: chunk.isEndOfFile,
  };
}

function toHunk(hunk: MutableHunk): ParsedHunk {
  if (hunk.kind === "update") {
    return {
      kind: "update",
      path: hunk.path,
      moveTo: hunk.moveTo,
      chunks: hunk.chunks.map((chunk) => toChunk(chunk)),
    };
  }
  if (hunk.kind === "add") {
    return { kind: "add", path: hunk.path, content: hunk.content };
  }
  return { kind: "delete", path: hunk.path };
}

export function parsePatch(text: string): ParsedPatch {
  const lines = patchLines(text);
  const finalLine = lines.at(-1);
  if (finalLine === undefined) throw invalidPatch(LAST_LINE_ERROR);
  const parser = new StreamingParser();
  for (const line of lines.slice(0, -1)) {
    parser.push(stripTrailingCr(line));
  }
  parser.finish(stripTrailingCr(finalLine));
  return {
    text: lines.join("\n"),
    hunks: parser.hunks.map((hunk) => toHunk(hunk)),
    environmentId: parser.environmentId,
  };
}
