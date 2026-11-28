import { CancellationError, FileSystemError } from "@harness/vscode-types";
import { z } from "zod";

export const TERMINAL_LAUNCH_ERROR_NAME = "TerminalLaunchError";

export const ExtHostWireErrorSchema = z.object({
  error: z.string(),
  errorStack: z.string().optional(),
  errorName: z.string().optional(),
  fileSystemErrorCode: z.string().optional(),
  cancelled: z.literal(true).optional(),
});

export type ExtHostWireError = z.infer<typeof ExtHostWireErrorSchema>;

export function encodeExtHostError(error: unknown): ExtHostWireError {
  if (!(error instanceof Error)) return { error: String(error) };
  return {
    error: error.message,
    errorStack: error.stack,
    errorName: error.name,
    ...(error instanceof FileSystemError ? { fileSystemErrorCode: error.code } : {}),
    cancelled: error instanceof CancellationError ? true : undefined,
  };
}

export function decodeExtHostError(payload: ExtHostWireError): Error {
  const error =
    payload.fileSystemErrorCode !== undefined
      ? new FileSystemError(payload.error, payload.fileSystemErrorCode)
      : payload.cancelled
        ? new CancellationError()
        : new Error(payload.error);
  error.message = payload.error;
  if (payload.errorStack !== undefined) error.stack = payload.errorStack;
  if (payload.errorName !== undefined) error.name = payload.errorName;
  return error;
}
