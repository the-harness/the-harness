import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApplyPatchError } from "./error.ts";
import { decodeUtf8, utf8DecodeError } from "./utf8.ts";

const OS_ERRORS: Record<string, readonly [string, number]> = {
  EACCES: ["Permission denied", 13],
  EEXIST: ["File exists", 17],
  EISDIR: ["Is a directory", 21],
  EINVAL: ["Invalid argument", 22],
  ELOOP: ["Too many levels of symbolic links", 62],
  ENAMETOOLONG: ["File name too long", 63],
  ENOENT: ["No such file or directory", 2],
  ENOSPC: ["No space left on device", 28],
  ENOTDIR: ["Not a directory", 20],
  EPERM: ["Operation not permitted", 1],
  EROFS: ["Read-only file system", 30],
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function osName(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

export function ioMessage(error: unknown): string {
  const code = errorCode(error);
  const known =
    code !== undefined && Object.hasOwn(OS_ERRORS, code) ? OS_ERRORS[code] : undefined;
  if (known !== undefined) return `${known[0]} (os error ${known[1]})`;
  return error instanceof Error ? error.message : String(error);
}

export function joinPath(base: string, path: string): string {
  if (path.includes("\0")) {
    throw new ApplyPatchError(`'${path}' is invalid on '${osName()}'`);
  }
  return resolve(base, path);
}

export function readFileText(path: string, context: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new ApplyPatchError(`${context} ${path}: ${ioMessage(error)}`);
  }
  const decodeError = utf8DecodeError(bytes);
  if (decodeError !== undefined) {
    throw new ApplyPatchError(`${context} ${path}: ${decodeError}`);
  }
  return decodeUtf8(bytes);
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function writeFileText(path: string, content: string): void {
  try {
    writeFileSync(path, content);
  } catch (error) {
    throw new ApplyPatchError(`Failed to write file ${path}: ${ioMessage(error)}`);
  }
}

export function writeFileCreatingParents(path: string, content: string): void {
  try {
    writeFileSync(path, content);
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw new ApplyPatchError(`Failed to write file ${path}: ${ioMessage(error)}`);
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw new ApplyPatchError(`Failed to create parent directories for ${path}: ${ioMessage(error)}`);
  }
  writeFileText(path, content);
}

function statIsDirectory(path: string, context: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    throw new ApplyPatchError(`${context}: ${ioMessage(error)}`);
  }
}

export function ensureNotDirectory(path: string, context: string): void {
  if (statIsDirectory(path, context)) {
    throw new ApplyPatchError(`${context}: path is a directory`);
  }
}

export function removeFile(path: string, context: string): void {
  ensureNotDirectory(path, context);
  try {
    unlinkSync(path);
  } catch (error) {
    throw new ApplyPatchError(`${context}: ${ioMessage(error)}`);
  }
}

export function deleteFile(path: string): void {
  removeFile(path, `Failed to delete file ${path}`);
}
