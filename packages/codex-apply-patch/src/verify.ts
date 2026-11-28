/**
 * Port of OpenAI Codex rust-v0.147.0 apply-patch invocation.rs verification and
 * lib.rs apply pass. Copyright 2025 OpenAI. Apache-2.0 portions and modification
 * notice: ../LICENSE.
 */

import { resolve } from "node:path";
import { ApplyPatchError, invalidPatch } from "./error.ts";
import {
  deleteFile,
  joinPath,
  readFileText,
  removeFile,
  writeFileCreatingParents,
  writeFileText,
} from "./io.ts";
import { parsePatch } from "./parse.ts";
import { applyReplacements, computeReplacements, parseSourceFile } from "./text.ts";
import type { ApplyPatchFileChange, ParsedPatch, VerifiedFileChange, VerifiedPatch } from "./types.ts";

export function verifyPatch(patch: ParsedPatch, cwd: string): VerifiedPatch {
  const base = resolve(cwd);
  const changes: VerifiedFileChange[] = [];
  const targets = new Set<string>();
  for (const hunk of patch.hunks) {
    const absPath = joinPath(base, hunk.path);
    if (targets.has(absPath)) {
      throw invalidPatch(`multiple operations target ${absPath}`);
    }
    targets.add(absPath);
    if (hunk.kind === "add") {
      changes.push({ kind: "add", path: hunk.path, absPath, content: hunk.content });
      continue;
    }
    if (hunk.kind === "delete") {
      readFileText(absPath, "Failed to read");
      changes.push({ kind: "delete", path: hunk.path, absPath });
      continue;
    }
    const original = readFileText(absPath, "Failed to read file to update");
    const source = parseSourceFile(original);
    const lines = source.lines.map((line) => line.text);
    const replacements = computeReplacements(lines, absPath, hunk.chunks);
    const content = applyReplacements(source, replacements);
    const moveAbsPath = hunk.moveTo === undefined ? undefined : joinPath(base, hunk.moveTo);
    changes.push({
      kind: "update",
      path: hunk.path,
      absPath,
      moveTo: hunk.moveTo,
      moveAbsPath,
      content,
    });
  }
  return { cwd: base, changes };
}

function toFileChange(change: VerifiedFileChange): ApplyPatchFileChange {
  if (change.kind === "update" && change.moveTo !== undefined) {
    return { path: change.path, kind: "update", moveTo: change.moveTo };
  }
  return { path: change.path, kind: change.kind };
}

export function applyPatch(verified: VerifiedPatch): ApplyPatchFileChange[] {
  if (verified.changes.length === 0) {
    throw new ApplyPatchError("No files were modified.");
  }
  for (const change of verified.changes) {
    if (change.kind === "add") {
      writeFileCreatingParents(change.absPath, change.content);
      continue;
    }
    if (change.kind === "delete") {
      deleteFile(change.absPath);
      continue;
    }
    if (change.moveAbsPath === undefined) {
      writeFileText(change.absPath, change.content);
      continue;
    }
    writeFileCreatingParents(change.moveAbsPath, change.content);
    removeFile(change.absPath, `Failed to remove original ${change.absPath}`);
  }
  return verified.changes.map((change) => toFileChange(change));
}

export function applyPatchFromText(text: string, cwd: string): ApplyPatchFileChange[] {
  return applyPatch(verifyPatch(parsePatch(text), cwd));
}

export function formatPatchSummary(changes: readonly ApplyPatchFileChange[]): string {
  let summary = "Success. Updated the following files:\n";
  for (const change of changes) {
    if (change.kind === "add") summary += `A ${change.path}\n`;
  }
  for (const change of changes) {
    if (change.kind === "update") summary += `M ${change.moveTo ?? change.path}\n`;
  }
  for (const change of changes) {
    if (change.kind === "delete") summary += `D ${change.path}\n`;
  }
  return summary;
}
