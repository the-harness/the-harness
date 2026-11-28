export class ApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyPatchError";
  }
}

export function invalidPatch(message: string): ApplyPatchError {
  return new ApplyPatchError(`invalid patch: ${message}`);
}

export function invalidHunk(lineNumber: number, message: string): ApplyPatchError {
  return new ApplyPatchError(`invalid hunk at line ${lineNumber}, ${message}`);
}
