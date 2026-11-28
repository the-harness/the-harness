import { defineRpcContract, rpc } from "@harness/rpc";
import { defineStreamContract, stream } from "@harness/stream";
import { z } from "zod";

export const WorkspaceEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  relativePath: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number(),
  mtimeMs: z.number(),
  ignored: z.boolean().optional(),
});

export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const ReadDirResultSchema = z.object({
  entries: z.array(WorkspaceEntrySchema),
  truncated: z.boolean(),
});

export type ReadDirResult = z.infer<typeof ReadDirResultSchema>;

export const ReadFileResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]),
  mtimeMs: z.number(),
  size: z.number(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
});

export type ReadFileResult = z.infer<typeof ReadFileResultSchema>;

export const WorkspaceWatchEventSchema = z.object({
  type: z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]),
  root: z.string(),
  relativePath: z.string(),
  path: z.string(),
});

export type WorkspaceWatchEvent = z.infer<typeof WorkspaceWatchEventSchema>;

export const WorkspaceRpcContract = defineRpcContract("workspace", {
  browseRoot: rpc.call(z.object({}), z.object({ root: z.string() })),
  readDir: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string().optional(),
      showIgnored: z.boolean().optional(),
    }),
    ReadDirResultSchema,
  ),
  searchFiles: rpc.call(
    z.object({ root: z.string(), query: z.string() }),
    z.object({ paths: z.array(z.string()), truncated: z.boolean() }),
  ),
  readFile: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string(),
    }),
    ReadFileResultSchema,
  ),
  writeFile: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string(),
      content: z.string(),
      expectedMtimeMs: z.number().optional(),
    }),
    z.object({ mtimeMs: z.number(), size: z.number() }),
  ),
  createFile: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string(),
      content: z.string().optional(),
    }),
    z.object({ path: z.string(), mtimeMs: z.number() }),
  ),
  createDir: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string(),
    }),
    z.object({ path: z.string() }),
  ),
  renamePath: rpc.call(
    z.object({
      root: z.string(),
      oldRelativePath: z.string(),
      newRelativePath: z.string(),
    }),
    z.object({ path: z.string() }),
  ),
  deletePath: rpc.call(
    z.object({
      root: z.string(),
      relativePath: z.string(),
    }),
    z.void(),
  ),
});

export const WorkspaceStreamContract = defineStreamContract("workspace", {
  watchRoots: stream.channel(
    z.object({
      roots: z.array(z.string()),
    }),
    WorkspaceWatchEventSchema,
  ),
});
