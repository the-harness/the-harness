export interface ApplyPatchFileChange {
  readonly path: string;
  readonly kind: "add" | "delete" | "update";
  readonly moveTo?: string;
}

export interface UpdateFileChunk {
  readonly changeContext?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly contextLineIndices: readonly (readonly [number, number])[];
  readonly isEndOfFile: boolean;
}

export type ParsedHunk =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly chunks: readonly UpdateFileChunk[];
    };

export interface ParsedPatch {
  readonly text: string;
  readonly hunks: readonly ParsedHunk[];
  readonly environmentId?: string;
}

export type VerifiedFileChange =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly absPath: string;
      readonly content: string;
    }
  | { readonly kind: "delete"; readonly path: string; readonly absPath: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly absPath: string;
      readonly moveTo?: string;
      readonly moveAbsPath?: string;
      readonly content: string;
    };

export interface VerifiedPatch {
  readonly cwd: string;
  readonly changes: readonly VerifiedFileChange[];
}
