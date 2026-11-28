/**
 * Port of OpenAI Codex rust-v0.147.0 apply-patch seek_sequence.rs, file_update.rs
 * and text_file.rs. Copyright 2025 OpenAI. Apache-2.0 portions and modification
 * notice: ../LICENSE.
 */

import { ApplyPatchError } from "./error.ts";
import type { UpdateFileChunk } from "./types.ts";

const WHITE_SPACE = /\p{White_Space}/u;

const PUNCTUATION: readonly (readonly [RegExp, string])[] = [
  [/[\u2010-\u2015\u2212]/gu, "-"],
  [/[\u2018-\u201b]/gu, "'"],
  [/[\u201c-\u201f]/gu, '"'],
  [/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " "],
];

export type Replacement = readonly [
  start: number,
  oldLength: number,
  newLines: readonly string[],
];

interface SourceLine {
  readonly text: string;
  readonly ending: string | undefined;
}

export interface SourceFile {
  readonly lines: readonly SourceLine[];
  readonly preferred: string;
}

export function trimText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && WHITE_SPACE.test(value.charAt(start))) start += 1;
  while (end > start && WHITE_SPACE.test(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

export function trimEndText(value: string): string {
  let end = value.length;
  while (end > 0 && WHITE_SPACE.test(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

export function stripTrailingCr(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

export function parseSourceFile(contents: string): SourceFile {
  const lines: SourceLine[] = [];
  let preferred: string | undefined;
  let lineStart = 0;
  let cursor = 0;
  while (cursor < contents.length) {
    let ending: string;
    let endingLength: number;
    const byte = contents.charCodeAt(cursor);
    if (byte === 13 && contents.charCodeAt(cursor + 1) === 10) {
      ending = "\r\n";
      endingLength = 2;
    } else if (byte === 13) {
      ending = "\r";
      endingLength = 1;
    } else if (byte === 10) {
      ending = "\n";
      endingLength = 1;
    } else {
      cursor += 1;
      continue;
    }
    preferred ??= ending;
    lines.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += endingLength;
    lineStart = cursor;
  }
  if (lineStart < contents.length) {
    lines.push({ text: contents.slice(lineStart), ending: undefined });
  }
  return { lines, preferred: preferred ?? "\n" };
}

export function applyReplacements(
  source: SourceFile,
  replacements: readonly Replacement[],
): string {
  const lines = source.lines;
  const preferred = source.preferred;
  const merged: SourceLine[] = [];
  let cursor = 0;
  for (const [start, oldLength, newLines] of replacements) {
    if (start > cursor) {
      for (let index = cursor; index < start; index += 1) {
        const line = lines.at(index);
        if (line !== undefined) merged.push(line);
      }
      cursor = start;
    }
    cursor = Math.min(cursor + oldLength, lines.length);
    for (const text of newLines) merged.push({ text, ending: preferred });
  }
  for (let index = cursor; index < lines.length; index += 1) {
    const line = lines.at(index);
    if (line !== undefined) merged.push(line);
  }
  let contents = "";
  for (const line of merged) {
    contents += line.text + (line.ending ?? preferred);
  }
  return contents;
}

function normalisePunctuation(value: string): string {
  let normalised = trimText(value);
  for (const [pattern, replacement] of PUNCTUATION) {
    normalised = normalised.replace(pattern, replacement);
  }
  return normalised;
}

function lineAt(lines: readonly string[], index: number): string {
  return lines.at(index) ?? "";
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const last = lines.length - pattern.length;
  const searchStart = eof ? Math.max(last, start) : start;
  const passes = [
    (value: string) => value,
    (value: string) => trimEndText(value),
    (value: string) => trimText(value),
    normalisePunctuation,
  ];
  for (const normalise of passes) {
    const expected = pattern.map((line) => normalise(line));
    for (let index = searchStart; index <= last; index += 1) {
      let matched = true;
      for (let offset = 0; offset < expected.length; offset += 1) {
        if (normalise(lineAt(lines, index + offset)) !== expected.at(offset)) {
          matched = false;
          break;
        }
      }
      if (matched) return index;
    }
  }
  return undefined;
}

export function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (contextIndex === undefined) {
        throw new ApplyPatchError(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = contextIndex + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, chunk.newLines]);
      continue;
    }
    let pattern: readonly string[] = chunk.oldLines;
    let newLines: readonly string[] = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) {
      throw new ApplyPatchError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    const startIndex = found;
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newLines.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          startIndex + oldStart,
          oldContext - oldStart,
          newLines.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newLines.length) {
      replacements.push([
        startIndex + oldStart,
        pattern.length - oldStart,
        newLines.slice(newStart),
      ]);
    }
    lineIndex = startIndex + pattern.length;
  }
  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}
